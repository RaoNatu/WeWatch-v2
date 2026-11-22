import { useCallback, useEffect, useRef, useState } from 'react';
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { collection, doc, onSnapshot, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore';
import { Activity, ArrowDownLeft, ArrowUpRight, Check, CircleHelp, Clapperboard, Copy, Film, Gauge, Headphones, LayoutDashboard, Link2, LoaderCircle, LockKeyhole, Pause, Play, Plus, Radio, RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, Type, Users, Wifi, X } from 'lucide-react';
import { auth, db } from '../firebase';

const fmt = (seconds = 0) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const roomRef = (code) => doc(db, 'rooms', code);
const memberRef = (code, uid) => doc(db, 'rooms', code, 'members', uid);
const defaultPreferences = { accent: '#bc4b32', fontScale: 1.2, layout: 'comfortable' };
const readPreferences = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('wewatch-preferences') || '{}');
    // The previous default was 105%; move that untouched default to a more readable size.
    if (Number(saved.fontScale) === 1.05) saved.fontScale = 1.2;
    // Replace the previous lime default with the new cinema-paper theme's brick accent.
    if (saved.accent?.toLowerCase() === '#d4f37b') saved.accent = '#bc4b32';
    return { ...defaultPreferences, ...saved };
  } catch { return defaultPreferences; }
};

async function createRoom(uid, name, initialPlayback) {
  for (let tries = 0; tries < 8; tries += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    try {
      await runTransaction(db, async (tx) => {
        const ref = roomRef(code);
        const current = await tx.get(ref);
        if (current.exists()) throw new Error('ROOM_COLLISION');
        const playback = { position: initialPlayback?.time || 0, duration: initialPlayback?.length || 0, movie: initialPlayback?.information?.category?.meta?.title || '', paused: true, updatedBy: uid, updatedAt: serverTimestamp() };
        tx.set(ref, { hostUid: uid, memberUids: [uid], memberCount: 1, playbackControlsEnabled: true, createdAt: serverTimestamp(), playback });
        tx.set(memberRef(code, uid), { uid, name, joinedAt: serverTimestamp(), playback });
      });
      return code;
    } catch (error) { if (error.message !== 'ROOM_COLLISION') throw error; }
  }
  throw new Error('Could not reserve a room code. Please try again.');
}

async function joinRoom(uid, name, code) {
  const ref = roomRef(code);
  await runTransaction(db, async (tx) => {
    const room = await tx.get(ref);
    if (!room.exists()) throw new Error('No room found with that code.');
    const data = room.data();
    if ((data.memberUids || []).includes(uid)) return;
    if ((data.memberUids || []).length >= 6) throw new Error('This room is full. Rooms can have up to six people.');
    const hostPlayback = data.playback || { position: 0, duration: 0, movie: '' };
    const joinPosition = hostPlayback.position || 0;
    const command = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action: 'pause', position: joinPosition, by: uid, createdAt: serverTimestamp() };
    tx.update(ref, {
      memberUids: [...(data.memberUids || []), uid],
      memberCount: (data.memberUids || []).length + 1,
      playback: { ...hostPlayback, position: joinPosition, paused: true, updatedBy: data.hostUid, updatedAt: serverTimestamp() },
      playbackCommand: command,
    });
    tx.set(memberRef(code, uid), { uid, name, joinedAt: serverTimestamp(), playback: { position: 0, duration: 0, movie: '', paused: true, updatedAt: serverTimestamp() } });
  });
  return code;
}

async function exitRoom(code, uid) {
  const ref = roomRef(code);
  return runTransaction(db, async (tx) => {
    const room = await tx.get(ref);
    if (!room.exists()) return { roomDeleted: true };
    const data = room.data();
    const memberUids = data.memberUids || [];
    if (!memberUids.includes(uid)) return { roomDeleted: false };
    if (data.hostUid === uid) {
      const memberDocs = await Promise.all(memberUids.map((memberUid) => tx.get(memberRef(code, memberUid))));
      memberDocs.forEach((member) => { if (member.exists()) tx.delete(member.ref); });
      tx.delete(ref);
      return { roomDeleted: true };
    }
    const self = await tx.get(memberRef(code, uid));
    const remainingUids = memberUids.filter((memberUid) => memberUid !== uid);
    tx.update(ref, { memberUids: remainingUids, memberCount: remainingUids.length });
    if (self.exists()) tx.delete(self.ref);
    return { roomDeleted: false };
  });
}

function App() {
  const [uid, setUid] = useState('');
  const [authReady, setAuthReady] = useState(false);
  const [name, setName] = useState(localStorage.getItem('wewatch-name') || '');
  const [preferences, setPreferences] = useState(readPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [code, setCode] = useState('');
  const [members, setMembers] = useState([]);
  const [room, setRoom] = useState(null);
  const [vlc, setVlc] = useState({ installed: false, running: false, managed: false });
  const [localPlayback, setLocalPlayback] = useState(null);
  const [mediaName, setMediaName] = useState('No movie selected');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const deletingRoomRef = useRef(false);
  const lastSentRef = useRef(0);
  const applyingRemote = useRef(false);
  const lastAppliedCommandRef = useRef('');
  const initialCommandRoomRef = useRef('');
  const initializedPlaybackRoomRef = useRef('');
  const playbackRefreshRequestRef = useRef(0);
  const playbackActionBusyRef = useRef(false);
  const lastLocalCommandRef = useRef(null);
  const roomReceivedAtRef = useRef(Date.now());
  const lastLocalSampleRef = useRef(null);
  const [playbackActionBusy, setPlaybackActionBusy] = useState(false);
  const pingSentRef = useRef(null);
  const lastPingReplyRef = useRef('');

  useEffect(() => {
    localStorage.setItem('wewatch-preferences', JSON.stringify(preferences));
    document.documentElement.style.setProperty('--lime', preferences.accent);
    document.documentElement.style.setProperty('--font-scale', String(preferences.fontScale));
    document.body.dataset.layout = preferences.layout;
  }, [preferences]);

  useEffect(() => onAuthStateChanged(auth, (user) => {
    if (user) { setUid(user.uid); setAuthReady(true); }
    else signInAnonymously(auth).catch((e) => { setError(`Firebase sign-in failed: ${e.message}`); setAuthReady(true); });
  }), []);

  const refreshVlc = useCallback(async () => {
    if (!window.desktop) return;
    const requestId = ++playbackRefreshRequestRef.current;
    try {
      const status = await window.desktop.status();
      const state = status.managed ? await window.desktop.readPlayback() : null;
      if (requestId !== playbackRefreshRequestRef.current) return;
      setVlc(status);
      if (state) setLocalPlayback(state);
    } catch {}
  }, []);
  useEffect(() => { refreshVlc(); const id = setInterval(refreshVlc, 600); return () => clearInterval(id); }, [refreshVlc]);

  useEffect(() => {
    if (!code) return undefined;
    const stopRoom = onSnapshot(roomRef(code), (snapshot) => {
      if (!snapshot.exists()) { if (!deletingRoomRef.current) setError('This room has ended.'); setCode(''); return; }
      roomReceivedAtRef.current = Date.now();
      setRoom(snapshot.data());
    }, (e) => setError(`Room connection issue: ${e.message}`));
    const stopMembers = onSnapshot(collection(db, 'rooms', code, 'members'), (snapshot) => setMembers(snapshot.docs.map((d) => ({ ...d.data(), receivedAt: Date.now() }))));
    return () => { stopRoom(); stopMembers(); };
  }, [code]);

  const leaveRoom = async () => {
    if (!code || !uid) { setCode(''); return; }
    setBusy('leave');
    setError('');
    deletingRoomRef.current = true;
    try {
      await exitRoom(code, uid);
      setMembers([]);
      setRoom(null);
      setCode('');
    } catch (e) {
      setError(`Couldn't close the room: ${e.message}`);
    } finally {
      deletingRoomRef.current = false;
      setBusy('');
    }
  };

  useEffect(() => {
    if (!window.desktop?.onBeforeClose) return undefined;
    return window.desktop.onBeforeClose(async () => {
      try { if (code && uid) await exitRoom(code, uid); }
      catch (e) { console.error('Room cleanup on app close failed:', e); }
      finally { window.desktop.closeCleanupDone(); }
    });
  }, [code, uid]);

  const remotePlayback = room?.playback;
  const isHost = Boolean(room && uid && room.hostUid === uid);
  const peer = members.find((member) => member.uid !== uid);
  const peerPlayback = peer?.playback;
  const publishPlaybackCommand = useCallback((action, position) => {
    const command = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action, by: uid, createdAt: serverTimestamp() };
    if (position !== undefined) command.position = position;
    return updateDoc(roomRef(code), { playbackCommand: command });
  }, [code, uid]);

  useEffect(() => {
    initializedPlaybackRoomRef.current = '';
    lastAppliedCommandRef.current = '';
    initialCommandRoomRef.current = '';
    lastLocalSampleRef.current = null;
  }, [code]);

  useEffect(() => {
    if (!code || !room || initialCommandRoomRef.current === code) return;
    initialCommandRoomRef.current = code;
    lastAppliedCommandRef.current = room.playbackCommand?.id || '';
  }, [code, room]);

  useEffect(() => {
    if (!remotePlayback || !code || !uid || remotePlayback.updatedBy === uid || !vlc.managed || applyingRemote.current) return;
    const initialRoomSync = initializedPlaybackRoomRef.current !== code;
    initializedPlaybackRoomRef.current = code;
    const followHost = initialRoomSync || !room?.playbackControlsEnabled;
    if (!followHost) return;
    const apply = async () => {
      applyingRemote.current = true;
      try {
        const state = await window.desktop.readPlayback();
        if (state) {
          const age = Math.min(2.5, Math.max(0, (Date.now() - roomReceivedAtRef.current) / 1000));
          const target = (remotePlayback.position || 0) + (remotePlayback.paused ? 0 : age);
          const stateMismatch = remotePlayback.paused !== (state.state !== 'playing');
          if (followHost && stateMismatch) await window.desktop.control(remotePlayback.paused ? 'pause' : 'play');
          const driftLimit = remotePlayback.paused && stateMismatch ? 0.8 : 1.5;
          if (followHost && Math.abs((state.time || 0) - target) > driftLimit) await window.desktop.control('seek', target);
        }
      } catch {}
      setTimeout(() => { applyingRemote.current = false; }, 1500);
    };
    apply();
  }, [code, room?.playbackControlsEnabled, remotePlayback?.position, remotePlayback?.paused, remotePlayback?.updatedBy, localPlayback?.time, localPlayback?.state, vlc.managed, uid]);

  useEffect(() => {
    const command = room?.playbackCommand;
    if (!code || !uid || !vlc.managed || !command?.id || command.by === uid || lastAppliedCommandRef.current === command.id) return;
    if (!['play', 'pause', 'seek'].includes(command.action)) return;
    lastAppliedCommandRef.current = command.id;
    const joinedAt = members.find((member) => member.uid === uid)?.joinedAt?.toMillis?.();
    const commandAt = command.createdAt?.toMillis?.();
    if (joinedAt && commandAt && commandAt < joinedAt) return;
    applyingRemote.current = true;
    const applyCommand = async () => {
      if (command.action === 'pause' && typeof command.position === 'number') await window.desktop.control('seek', command.position);
      await window.desktop.control(command.action, command.position);
      await refreshVlc();
    };
    applyCommand().catch((e) => setError(`Playback sync failed: ${e.message}`)).finally(() => {
      setTimeout(() => { applyingRemote.current = false; }, 1500);
    });
  }, [code, uid, members, room?.playbackCommand?.id, room?.playbackCommand?.by, room?.playbackCommand?.action, room?.playbackCommand?.createdAt, vlc.managed, refreshVlc]);

  useEffect(() => {
    if (!localPlayback || !vlc.managed) return;
    const current = { time: localPlayback.time || 0, state: localPlayback.state, at: Date.now() };
    const previous = lastLocalSampleRef.current;
    lastLocalSampleRef.current = current;
    if (!previous || applyingRemote.current || !code) return;
    const actionChanged = current.state !== previous.state && ['playing', 'paused'].includes(current.state);
    const canControl = isHost || room?.playbackControlsEnabled;
    if (actionChanged && canControl) {
      const action = current.state === 'playing' ? 'play' : 'pause';
      const recent = lastLocalCommandRef.current;
      if (recent?.action === action && current.at - recent.at < 5000) lastLocalCommandRef.current = null;
      else publishPlaybackCommand(action).catch((e) => setError(`Couldn't sync playback: ${e.message}`));
    }
    if (!canControl) return;
    const elapsed = Math.max(0, (current.at - previous.at) / 1000);
    const expectedAdvance = previous.state === 'playing' ? elapsed : 0;
    const seekDelta = current.time - previous.time - expectedAdvance;
    if (Math.abs(seekDelta) < 1.75) return;
    publishPlaybackCommand('seek', current.time).catch((e) => setError(`Couldn't sync seek: ${e.message}`));
  }, [code, uid, isHost, room?.playbackControlsEnabled, localPlayback?.time, localPlayback?.state, vlc.managed, publishPlaybackCommand]);

  useEffect(() => {
    if (!code || !uid || !localPlayback || !vlc.managed) return;
    const now = Date.now();
    if (now - lastSentRef.current < 1250) return;
    lastSentRef.current = now;
    const movie = localPlayback?.information?.category?.meta?.title || mediaName;
    const memberPlayback = { position: localPlayback.time || 0, duration: localPlayback.length || 0, movie, paused: localPlayback.state !== 'playing', updatedAt: serverTimestamp() };
    updateDoc(memberRef(code, uid), { playback: memberPlayback }).catch(() => {});
    if (isHost && !applyingRemote.current) {
      updateDoc(roomRef(code), { playback: { ...memberPlayback, updatedBy: uid } }).catch(() => {});
    }
  }, [code, uid, localPlayback?.time, localPlayback?.state, localPlayback?.length, localPlayback?.information, mediaName, vlc.managed, isHost, room?.playbackControlsEnabled]);

  useEffect(() => {
    if (!code || !isHost) return undefined;
    const sendPing = () => {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pingSentRef.current = { nonce, at: Date.now() };
      updateDoc(roomRef(code), { pingRequest: { nonce, from: uid, createdAt: serverTimestamp() } }).catch(() => {});
    };
    sendPing();
    const timer = setInterval(sendPing, 10000);
    return () => clearInterval(timer);
  }, [code, isHost, uid]);

  useEffect(() => {
    const request = room?.pingRequest;
    if (!code || !uid || !request?.nonce || request.from === uid || lastPingReplyRef.current === request.nonce) return;
    lastPingReplyRef.current = request.nonce;
    updateDoc(roomRef(code), { pingReply: { nonce: request.nonce, from: uid, at: serverTimestamp() } }).catch(() => {});
  }, [code, uid, room?.pingRequest?.nonce, room?.pingRequest?.from]);

  useEffect(() => {
    const sent = pingSentRef.current;
    if (!isHost || !sent || room?.pingReply?.nonce !== sent.nonce) return;
    const pingMs = Date.now() - sent.at;
    pingSentRef.current = null;
    updateDoc(roomRef(code), { ping: { ms: pingMs, measuredAt: serverTimestamp() } }).catch(() => {});
  }, [code, isHost, room?.pingReply?.nonce]);

  const runRoomAction = async (action, value) => {
    setError(''); setBusy(action);
    try {
      if (!authReady || !uid) throw new Error('Connecting securely to Firebase…');
      if (!name.trim()) throw new Error('Add your name before entering a room.');
      localStorage.setItem('wewatch-name', name.trim());
      const joinedCode = action === 'create' ? await createRoom(uid, name.trim(), vlc.managed ? localPlayback : null) : await joinRoom(uid, name.trim(), value);
      if (action === 'create' && vlc.managed) {
        try { await window.desktop.control('pause'); await refreshVlc(); }
        catch (e) { setError(`Room created, but VLC could not be paused: ${e.message}`); }
      }
      setCode(joinedCode); setCodeInput('');
    } catch (e) { setError(e.message || 'Something went wrong. Please try again.'); }
    finally { setBusy(''); }
  };

  const statusLabel = vlc.managed ? 'VLC connected' : vlc.running ? 'VLC running · not connected' : vlc.installed ? 'VLC installed · not running' : 'VLC not installed';
  const peerPos = peerPlayback ? (peerPlayback.position || 0) : 0;
  const ownPos = localPlayback?.time || 0;
  const drift = peerPlayback ? ownPos - peerPos : null;
  const driftLabel = drift === null ? 'Waiting for their player' : Math.abs(drift) <= 2.5 ? 'In sync' : `${isHost ? 'Guest' : 'Host'} ${fmt(Math.abs(drift))} ${drift > 0 ? 'behind' : 'ahead'}`;
  const copyCode = async () => { await navigator.clipboard.writeText(code); setToast('Room code copied'); setTimeout(() => setToast(''), 1800); };
  const startVlc = async () => { setError(''); try { await window.desktop.startVlc(); refreshVlc(); } catch (e) { setError(e.message); } };
  const chooseMovie = async () => { setError(''); try { const picked = await window.desktop.chooseMovie(); if (picked) { setMediaName(picked.name); refreshVlc(); } } catch (e) { setError(e.message); } };
  const togglePlayback = async () => {
    if (!window.desktop || playbackActionBusyRef.current || (!isHost && code && !room?.playbackControlsEnabled)) return;
    playbackActionBusyRef.current = true;
    setPlaybackActionBusy(true);
    playbackRefreshRequestRef.current += 1;
    try {
      const current = await window.desktop.readPlayback();
      const action = (current?.state || localPlayback?.state) === 'playing' ? 'pause' : 'play';
      lastLocalCommandRef.current = { action, at: Date.now() };
      await window.desktop.control(action);
      if (code && (isHost || room?.playbackControlsEnabled)) await publishPlaybackCommand(action);
      await refreshVlc();
    } catch (e) { setError(`Playback control failed: ${e.message}`); }
    finally { playbackActionBusyRef.current = false; setPlaybackActionBusy(false); }
  };
  const syncWithHost = async () => {
    const host = members.find((member) => member.uid === room?.hostUid);
    if (!host?.playback || !vlc.managed) { setError('The host needs to start a movie before you can sync.'); return; }
    applyingRemote.current = true;
    try {
      const age = Math.min(3, Math.max(0, (Date.now() - (host.receivedAt || Date.now())) / 1000));
      const target = (host.playback.position || 0) + (host.playback.paused ? 0 : age);
      await window.desktop.control('seek', target);
      await window.desktop.control(host.playback.paused ? 'pause' : 'play');
      const synced = await window.desktop.readPlayback();
      const shouldPlay = !host.playback.paused;
      if (synced && (synced.state === 'playing') !== shouldPlay) {
        await window.desktop.control(shouldPlay ? 'play' : 'pause');
      }
      await refreshVlc();
      setToast('Synced with the host'); setTimeout(() => setToast(''), 1800);
    } catch (e) { setError(e.message); }
    finally { setTimeout(() => { applyingRemote.current = false; }, 1500); }
  };
  const toggleMemberControls = async () => {
    if (!isHost || !code) return;
    try { await updateDoc(roomRef(code), { playbackControlsEnabled: !room.playbackControlsEnabled }); }
    catch (e) { setError(e.message); }
  };
  const saveSettings = (next) => setPreferences((current) => ({ ...current, ...next }));
  const progress = localPlayback?.length ? Math.min(100, ((localPlayback.time || 0) / localPlayback.length) * 100) : 0;
  const title = localPlayback?.information?.category?.meta?.title || mediaName;

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#home" aria-label="WeWatch home"><span className="brand-mark"><Clapperboard size={21} /></span><span className="brand-word">wewatch</span><span className="brand-beta">WATCH CLUB</span></a>
      <div className="top-center"><span className="live-dot" /> YOUR PRIVATE LITTLE CINEMA</div>
      <div className="top-actions"><span className="avatar">{name.trim().slice(0, 1).toUpperCase() || 'Y'}</span><span className="your-name">{name || 'Your profile'}</span><button className="icon-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings2 size={20} /><span>Settings</span></button></div>
    </header>
    <div className="main-layout" id="home">
      <section className="content">
        <div className="eyebrow"><span>WEWATCH PRESENTS</span><i /></div>
        <div className="intro"><div><h1>Movie night,<br /><em>together.</em></h1><p className="subtitle">A little closer, one frame at a time.</p></div><div className="heading-note"><span className="ticket-stub">ADMIT<br />TWO</span></div></div>
        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={18} /></button></div>}

        {!code ? <div className="lobby-grid">
          <article className="panel room-panel">
            <div className="panel-head"><span className="panel-number">01</span><div><span className="panel-overline">TAKE THE LEAD</span><h2>Open a room</h2><p>Make a private place for up to six.</p></div></div>
            <label className="field-label" htmlFor="name">YOUR NAME</label><div className="input-wrap"><Users size={19} /><input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="What should we call you?" /></div>
            <button className="primary-btn" disabled={Boolean(busy)} onClick={() => runRoomAction('create')}><span>{busy === 'create' ? 'Opening your room…' : 'Create a room'}</span>{busy === 'create' ? <LoaderCircle className="spin" size={19} /> : <ArrowUpRight size={19} />}</button>
            <div className="secure-note"><LockKeyhole size={16} /> Invite-only · up to six seats</div>
          </article>
          <article className="panel join-panel">
            <div className="panel-head"><span className="panel-number">02</span><div><span className="panel-overline">YOU HAVE AN INVITE?</span><h2>Join a room</h2><p>Enter the six digits your person sent.</p></div></div>
            <label className="field-label" htmlFor="room-code">ROOM CODE</label><div className="input-wrap code-input"><Link2 size={19} /><input id="room-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={codeInput} onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000 000" /></div>
            <button className="secondary-btn" disabled={Boolean(busy) || codeInput.length !== 6} onClick={() => runRoomAction('join', codeInput)}><span>{busy === 'join' ? 'Finding your room…' : 'Join the room'}</span>{busy === 'join' ? <LoaderCircle className="spin" size={19} /> : <ArrowUpRight size={19} />}</button>
            <div className="secure-note"><ShieldCheck size={17} /> Your invite is your key</div>
          </article>
        </div> : <RoomView code={code} uid={uid} members={members} peer={peer} name={name} room={room} isHost={isHost} peerPlayback={peerPlayback} pingMs={room?.ping?.ms} driftLabel={driftLabel} copyCode={copyCode} onLeave={leaveRoom} leaving={busy === 'leave'} onToggleControls={toggleMemberControls} onSyncHost={syncWithHost} />}

        <section className="setup-section">
          <div className="section-title"><div><span className="section-kicker">THE PROJECTOR BOOTH</span><h2>Your local player</h2></div><div className={`vlc-pill ${vlc.managed ? 'connected' : vlc.installed ? 'available' : 'missing'}`}><span />{statusLabel}</div></div>
          <div className="player-card">
            <div className="player-art"><span className="reel reel-one" /><span className="reel reel-two" /><span className="art-core"><Film size={32} /></span></div>
            <div className="player-info"><span className="playing-label"><span className={vlc.managed ? 'live-dot' : 'idle-dot'} /> {vlc.managed ? 'CONNECTED TO VLC' : 'VLC MEDIA PLAYER'}</span><h3>{title}</h3><p>{vlc.managed ? (localPlayback?.length ? `${fmt(localPlayback.time)} of ${fmt(localPlayback.length)}` : 'VLC is running. Choose a movie to get started.') : 'Connect your local player to watch in sync.'}</p><div className="progress-track"><div style={{ width: `${progress}%` }} /></div></div>
            <div className="player-actions">{vlc.managed && <button className="playback-btn" disabled={playbackActionBusy || Boolean(code && !isHost && !room?.playbackControlsEnabled)} onClick={togglePlayback} aria-label="Toggle playback" title={code && !isHost && !room?.playbackControlsEnabled ? 'Host has disabled member controls' : 'Toggle playback'}>{localPlayback?.state === 'playing' ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>}<button className="outline-btn" onClick={chooseMovie}><Film size={18} />{vlc.managed ? 'Choose movie' : 'Choose movie & launch'}</button>{!vlc.managed && <button className="start-btn" onClick={startVlc}><Play size={17} fill="currentColor" /> Start VLC</button>}</div>
          </div>
          <div className="feature-row"><div><Wifi size={19} /><span>Low-latency sync</span></div><div><Users size={19} /><span>Up to six together</span></div><div><Headphones size={19} /><span>Bring your own movie</span></div></div>
        </section>
      </section>
      <aside className="side-rail">
        <div className="side-top"><span className="section-kicker">THE MAGIC, IN REAL TIME</span><h2>Two sofas.<br /><em>One shared moment.</em></h2><p>WeWatch lines up both VLC players, so the only thing you need to agree on is what to watch.</p></div>
        <div className="sync-visual"><div className="visual-top"><span><span className="live-dot" /> ROOM SNAPSHOT</span><span className="visual-code">{code || '— — —'}</span></div><div className="visual-screen"><div className="screen-content"><div className="screen-play"><Play size={18} fill="currentColor" /></div><span>{peerPlayback?.movie || (title !== 'No movie selected' ? title : 'YOUR MOVIE GOES HERE')}</span></div><div className="screen-bottom"><span>{peerPlayback ? fmt(peerPlayback.position || 0) : '—:——'}</span><div className="screen-track"><i style={{ width: `${peerPlayback?.duration ? Math.min(100, (peerPlayback.position / peerPlayback.duration) * 100) : 0}%` }} /></div><span>{peerPlayback?.duration ? fmt(peerPlayback.duration) : '—:——'}</span></div></div><div className="sync-people"><div className="person"><span className="avatar small">{name.trim().slice(0, 1).toUpperCase() || 'Y'}</span><span><b>{name || 'You'}</b><small>{isHost ? 'HOST PLAYER' : 'YOUR PLAYER'}</small></span><i className={vlc.managed ? 'person-online' : ''} /></div><div className="sync-wave"><span /><span /><span /><span /><span /><span /><span /></div><div className="person"><span className="avatar small friend">{peer?.name?.slice(0, 1).toUpperCase() || '＋'}</span><span><b>{peer?.name || 'Your person'}</b><small>{peerPlayback?.paused === false ? fmt(peerPlayback.position) + ' PLAYING' : peer ? 'PLAYER PAUSED' : 'WAITING FOR THEM'}</small></span><i className={peer ? 'person-online' : ''} /></div></div><div className="peer-meta"><span><Gauge size={16} /> {room?.ping?.ms ? `Room ping · ${room.ping.ms} ms` : 'Room ping · measuring'}</span><b className={drift === null ? '' : Math.abs(drift) <= 2.5 ? 'good' : 'warn'}>{driftLabel}</b></div></div>
        <div className="tip-card"><div className="tip-icon"><CircleHelp size={19} /></div><div><b>Bring your own popcorn.</b><p>Everyone needs the same movie file. WeWatch handles the timing.</p><a href="https://www.videolan.org/vlc/" target="_blank" rel="noreferrer">Get VLC media player <ArrowUpRight size={15} /></a></div></div>
        <div className="side-footer"><span>MADE FOR THE DISTANCE</span><span>✳</span></div>
      </aside>
    </div>
    <div className="window-footer"><span><Activity size={15} /> {authReady ? 'Connected to the watch club' : 'Connecting to the watch club'}</span><span>WEWATCH DESKTOP <i>·</i> 0.1.0</span></div>
    {settingsOpen && <SettingsPanel name={name} preferences={preferences} onNameChange={setName} onChange={saveSettings} onClose={async () => { localStorage.setItem('wewatch-name', name.trim()); if (code && uid) updateDoc(memberRef(code, uid), { name: name.trim() }).catch(() => {}); setSettingsOpen(false); }} />}
    {toast && <div className="toast"><Check size={18} />{toast}</div>}
  </main>;
}

function RoomView({ code, uid, members, peer, name, room, isHost, peerPlayback, pingMs, driftLabel, copyCode, onLeave, leaving, onToggleControls, onSyncHost }) {
  const host = members.find((member) => member.uid === room?.hostUid);
  const participants = [...members];
  if (!participants.some((member) => member.uid === uid)) participants.unshift({ uid, name });
  const formatPosition = (playback) => playback ? `${fmt(playback.position || 0)} / ${fmt(playback.duration || 0)}` : 'No movie playing';
  return <section className="active-room panel"><div className="room-live"><div><div className="section-kicker">YOUR PRIVATE ROOM · {members.length || 1}/6 WATCHING</div><h2>You're in. <em>Invite your people.</em></h2></div><button className="leave-btn" disabled={leaving} onClick={onLeave}><X size={18} /> {leaving ? (isHost ? 'Closing room…' : 'Leaving room…') : (isHost ? 'Close room for everyone' : 'Leave room')}</button></div><div className="room-invite"><div><span>SHARE THIS SIX-DIGIT ROOM CODE</span><strong>{code.slice(0, 3)} <b>{code.slice(3)}</b></strong></div><button className="copy-btn" onClick={copyCode}><Copy size={18} /> Copy invite code</button></div>
    <div className="current-user-banner"><span className="avatar current-user-avatar">{name.trim().slice(0, 1).toUpperCase() || 'Y'}</span><div><small>YOU'RE WATCHING AS</small><b>{name || 'Your profile'}</b></div><span className="current-user-role">{isHost ? 'HOST' : 'MEMBER'} · YOU</span></div>
    <div className="room-members">{participants.map((member) => { const isCurrentUser = member.uid === uid; const memberIsHost = member.uid === room?.hostUid; return <div className={`room-member ${isCurrentUser ? 'current-user-row' : ''}`} key={member.uid}><span className={`avatar ${isCurrentUser ? '' : 'friend'}`}>{member.name?.slice(0, 1).toUpperCase() || '＋'}</span><div><b>{member.name || (isCurrentUser ? 'You' : 'Guest')}</b><small>{memberIsHost ? 'HOST' : 'MEMBER'}{isCurrentUser ? ' · YOU' : ''}{member.playback?.paused === false ? ' · PLAYING' : ''}</small><small className="member-title"><Film size={11} /> {member.playback?.movie || 'Movie not selected'}</small><small className="member-movie">{formatPosition(member.playback)}</small></div><span className="member-ready"><Check size={12} /> {isCurrentUser ? 'YOU' : 'HERE'}</span></div>; })}</div>
    <div className="room-controls"><div className="room-control-info"><span className="ping-tag"><Gauge size={14} /> {pingMs ? `${pingMs} ms relay ping` : 'Measuring room ping…'}</span><span className={`drift-tag ${driftLabel === 'In sync' ? 'good' : ''}`}>{driftLabel}</span></div>{isHost ? <button className={`control-toggle ${room?.playbackControlsEnabled ? 'enabled' : ''}`} onClick={onToggleControls}><span className="toggle-switch"><i /></span> Member playback controls <b>{room?.playbackControlsEnabled ? 'ON' : 'OFF'}</b></button> : <button className="sync-host-btn" onClick={onSyncHost}><RefreshCw size={15} /> Sync with host</button>}</div>
    <div className="room-hint"><LockKeyhole size={14} /> {isHost ? 'You are the host. Choose whether your guest can control playback.' : `The host is ${host?.name || 'your friend'}. ${room?.playbackControlsEnabled ? 'You can control playback.' : 'Playback controls are managed by the host.'}`}</div></section>;
}

function SettingsPanel({ name, preferences, onNameChange, onChange, onClose }) {
  const swatches = ['#bc4b32', '#355c4d', '#416b86', '#7d5a83', '#bd6670', '#cf8b3d'];
  return <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="settings-head"><div className="settings-heading-icon"><SlidersHorizontal size={21} /></div><div><span className="section-kicker">YOUR WATCH SPACE</span><h2 id="settings-title">Settings</h2></div><button className="settings-close" onClick={onClose} aria-label="Close settings"><X size={20} /></button></div>
    <div className="setting-group"><label className="setting-label"><Users size={15} /> Profile</label><div className="setting-row"><div><b>Display name</b><small>This is how you appear in rooms.</small></div><input className="settings-name" maxLength={24} value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Your name" /></div></div>
    <div className="setting-group"><label className="setting-label"><Type size={17} /> Appearance</label><div className="font-samples" aria-label="Typography samples"><div className="font-sample-display"><small>HEADLINES · PLAYFAIR DISPLAY</small><span>Movie night, together.</span></div><div className="font-sample-reading"><small>READING · DM SANS</small><span>Settle in. Your movie is ready.</span></div><div className="font-sample-utility"><small>DETAILS · DM MONO</small><span>ROOM CODE  123 456</span></div></div><div className="setting-row"><div><b>Text size</b><small>Scale text and interface icons from 90% to 200%.</small></div><div className="size-control"><span>A</span><input aria-label="Text size" type="range" min="0.9" max="2" step="0.05" value={preferences.fontScale} onChange={(event) => onChange({ fontScale: Number(event.target.value) })} /><strong>A</strong><em>{Math.round(preferences.fontScale * 100)}%</em></div></div>
    <div className="setting-row"><div><b>Layout spacing</b><small>Choose how much room the panels get.</small></div><div className="layout-options">{['compact', 'comfortable', 'spacious'].map((layout) => <button key={layout} className={preferences.layout === layout ? 'selected' : ''} onClick={() => onChange({ layout })}><LayoutDashboard size={14} />{layout}</button>)}</div></div>
    <div className="setting-row"><div><b>Accent color</b><small>Personalize your WeWatch highlights.</small></div><div className="color-options">{swatches.map((color) => <button key={color} style={{ '--swatch': color }} className={preferences.accent.toLowerCase() === color ? 'selected' : ''} onClick={() => onChange({ accent: color })} aria-label={`Use ${color}`} />)}<label className="custom-color" title="Choose a custom color"><input type="color" value={preferences.accent} onChange={(event) => onChange({ accent: event.target.value })} /><Plus size={15} /></label></div></div></div>
    <div className="settings-foot"><span><Check size={14} /> Preferences save automatically on this device.</span><button className="settings-done" onClick={onClose}>Done</button></div></section></div>;
}

export default App;
