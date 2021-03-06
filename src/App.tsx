import React, { useEffect, useRef, useState } from 'react';
import _ from 'lodash';
import Peer, { DataConnection, PeerConnectOption } from 'peerjs';
import EventEmitter from 'events';

type SeedsMessage = {
  type: 'seeds';
  peerIds: string[];
};

type ChatLine = {
  id: string;
  sender: string;
  content: string;
};

type ChatMessage = {
  type: 'chat';
  lines: ChatLine[];
};

type Message = SeedsMessage | ChatMessage;

const randomId = () => {
  const a = Math.random().toString(36).substring(7);
  const b = Math.random().toString(36).substring(7);
  return `${a}-${b}`;
};

class MessagingPeer extends EventEmitter {
  private static PeerIDSeed = '407d10227d90';

  private peerId: string;
  private peer: Peer;
  private connections: Map<string, DataConnection> = new Map();
  private conversation: ChatLine[] = [];
  private isLoading = true;
  private lastError: string | null = null;

  constructor(private username?: string) {
    super();

    this.peerId = username
      ? `${MessagingPeer.PeerIDSeed}-${_.kebabCase(username)}`
      : MessagingPeer.PeerIDSeed;
    this.peer = new Peer(this.peerId);

    // When there is an error
    this.peer.on('error', (error) => {
      console.error(error);

      this.isLoading = false;

      if (error.type === 'peer-unavailable') {
        this.lastError = `peer is unreachable`; // if connection with new peer can't be established
      } else if (error.type === 'unavailable-id') {
        this.lastError = `${this.peerId} is already taken`;
      } else {
        this.lastError = error;
      }

      this.emit('update');
    });

    // When a peer connects to us
    this.peer.on('connection', (conn) => {
      console.debug(`[${this.peerId}] peer ${conn.peer} reached us`);
      this.handleNewConnection(conn);
    });

    // When the connection is properly open
    this.peer.on('open', () => {
      this.isLoading = false;
      this.lastError = null;
      console.debug(`[${this.peerId}] connected`);

      this.emit('update');

      // Connect to known seed
      this.connectToPeer(MessagingPeer.PeerIDSeed);
    });
  }

  private connectToPeer(peerId: string) {
    // Already in the pool
    if (this.connections.has(peerId) || peerId === this.peerId) return;

    console.debug(`[${this.peerId}] connecting to ${peerId}`);

    const opts: PeerConnectOption = {
      metadata: {
        peerIds: Array.from(this.connections.keys()),
      },
      serialization: 'json',
    };
    const conn = this.peer.connect(peerId, opts);
    this.handleNewConnection(conn);
  }

  private handleNewConnection(conn: DataConnection) {
    // Already in the pool
    if (this.connections.has(conn.peer)) return;

    const peerIds: string[] = conn.metadata.peerIds ?? [];
    peerIds.forEach((peerId) => this.connectToPeer(peerId));

    conn.on('data', (data: Message) => {
      console.debug(
        `[${this.peerId}] peer ${conn.peer} sent a message type=${data.type}`
      );
      // console.log(data);
      if (data.type === 'seeds') {
        _.each(data.peerIds, (peerId) => this.connectToPeer(peerId));
      } else if (data.type === 'chat') {
        this.conversation = [...this.conversation, ...data.lines];
        this.conversation = _.uniqBy(this.conversation, (l) => l.id);
      }

      this.emit('update');
    });

    conn.on('close', () => this.connections.delete(conn.peer));
    conn.on('error', () => this.connections.delete(conn.peer));

    conn.on('open', () => {
      this.connections.set(conn.peer, conn);

      const seedsMsg: SeedsMessage = {
        type: 'seeds',
        peerIds: Array.from(this.connections.keys()),
      };
      this.send(seedsMsg);

      const initialConv: ChatMessage = {
        type: 'chat',
        lines: this.conversation,
      };
      this.send(initialConv);

      console.debug(`[${this.peerId}] peer ${conn.peer} connected`);
    });
  }

  private send(msg: Message) {
    this.connections.forEach((conn) => {
      conn.send(msg);
    });
  }

  public get error() {
    return this.lastError;
  }

  public get loading() {
    return this.isLoading;
  }

  public get chat() {
    return this.conversation;
  }

  public sendMessage(msg: string) {
    if (this.loading) throw new Error('not ready yet');

    const line = {
      id: randomId(),
      content: msg,
      sender: this.username ?? 'seed',
    };
    this.conversation.push(line);

    const newMsg: ChatMessage = {
      type: 'chat',
      lines: [line],
    };
    this.send(newMsg);
  }
}

// Tentative seed peer, might fail, already taken : normal
const gSeedPeer = new MessagingPeer();

const useMessagingPeer = (slug: string) => {
  const [peer, setPeer] = useState<MessagingPeer>();
  const [, setUpdateTime] = useState<number>();

  useEffect(() => {
    const p = new MessagingPeer(slug);
    p.on('update', () => setUpdateTime(_.now()));
    setPeer(p);
  }, [slug]);

  return peer;
};

// const gOtherPeer = new MessagingPeer(
//   _.sample(['clems71', 'kebe', 'barber', 'xax', 'thibo', 'fredo', 'mat'])
// );

type AppState = { type: 'login' } | { type: 'chat'; slug: string };

interface LoginPageProps {
  onLogin?: (username: string) => void;
}

const LoginPage = (props: LoginPageProps) => {
  const [name, setName] = useState('');
  const slug = _.kebabCase(name);

  return (
    <div>
      <form>
        <fieldset>
          <label>Your name</label>
          <input
            type="text"
            placeholder="Erlich Bachman"
            value={name}
            onChange={(evt) => setName(evt.target.value)}
          />
          <label>Generated slug</label>
          <input type="text" value={slug} readOnly={true} />
          <input
            className="button-primary"
            type="submit"
            value="Connect"
            disabled={slug.length < 3}
            onClick={(e) => {
              e.preventDefault();
              if (props.onLogin) props.onLogin(slug);
            }}
          />
        </fieldset>
      </form>
    </div>
  );
};

interface ChatPageProps {
  slug: string;
}

const ChatPage = (props: ChatPageProps) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const peer = useMessagingPeer(props.slug);
  const [currentLine, setCurrentLine] = useState<string>('');

  const chat = peer?.chat ?? [];
  const chatHistory = chat.map((l) => `${l.sender}: ${l.content}`).join('\n');

  useEffect(() => scrollToBottom(), [chatHistory]);

  return (
    <div>
      <blockquote>
        <p>
          Welcome <strong>{props.slug}</strong>!
        </p>
      </blockquote>
      {peer?.loading || (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            peer?.sendMessage(currentLine);
            setCurrentLine('');
          }}
        >
          <fieldset>
            <pre style={{ height: 300, overflow: 'scroll' }}>
              {chatHistory}
              <div ref={messagesEndRef} />
            </pre>
            <input
              type="text"
              placeholder="Your message..."
              value={currentLine}
              onChange={(evt) => setCurrentLine(evt.target.value)}
            />
          </fieldset>
        </form>
      )}
    </div>
  );
};

function App() {
  const [appState, setAppState] = useState<AppState>({ type: 'login' });

  return (
    <div className="container">
      <h1>Peer Test</h1>
      <div>
        This app is a proof of concept. It demonstrates an UDP based chat. It
        uses PeerJS.
      </div>
      {appState.type === 'login' && (
        <LoginPage
          onLogin={(slug) => {
            setAppState({ type: 'chat', slug });
          }}
        />
      )}
      {appState.type === 'chat' && <ChatPage slug={appState.slug} />}
    </div>
  );
}

export default App;
