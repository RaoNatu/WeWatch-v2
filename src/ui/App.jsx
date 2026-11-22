import { useCallback, useEffect, useRef, useState } from 'react';
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { addDoc, collection, doc, limitToLast, onSnapshot, orderBy, query, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore';
import { Activity, ArrowDownLeft, ArrowUpRight, Captions, Check, CircleHelp, Copy, Film, Gauge, Headphones, LayoutDashboard, Link2, LoaderCircle, LockKeyhole, Pause, Play, Plus, Radio, RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, Type, Users, Wifi, X } from 'lucide-react';
import { auth, db } from '../firebase';

const fmt = (seconds = 0) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const clockFmt = (seconds = 0) => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return [Math.floor(value / 3600), Math.floor((value % 3600) / 60), value % 60].map((part) => String(part).padStart(2, '0')).join(':');
};
const wallClockFmt = (value) => {
  const date = new Date(value);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
};
const readActivity = () => {
  try { return JSON.parse(localStorage.getItem('wewatch-activity') || '[]').slice(0, 80); }
  catch { return []; }
};
const readWatchHistory = () => {
  try {
    const history = JSON.parse(localStorage.getItem('wewatch-history') || '[]');
    return Array.isArray(history)
      ? history.filter((entry) => entry?.title && Number.isFinite(entry.playedAt)).slice(0, 1)
        .map((entry) => ({ ...entry, position: Math.max(0, Number(entry.position) || 0) }))
      : [];
  } catch { return []; }
};
const roomRef = (code) => doc(db, 'rooms', code);
const memberRef = (code, uid) => doc(db, 'rooms', code, 'members', uid);
const defaultPreferences = { accent: '#bc4b32', fontScale: 1.2, layout: 'comfortable', overlay: { enabled: true, position: 'top-right', customX: 78, customY: 8, duration: 2000, types: { playback: true, roomActivity: true, chat: true, reactions: true } } };
const movieGreeting = (hour = new Date().getHours()) => {
  if (hour >= 5 && hour < 12) return 'Movie Morning';
  if (hour < 17) return 'Movie Day';
  if (hour < 21) return 'Movie Evening';
  return 'Movie Night';
};
const readPreferences = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('wewatch-preferences') || '{}');
    // The previous default was 105%; move that untouched default to a more readable size.
    if (Number(saved.fontScale) === 1.05) saved.fontScale = 1.2;
    // Replace the previous lime default with the new cinema-paper theme's brick accent.
    if (saved.accent?.toLowerCase() === '#d4f37b') saved.accent = '#bc4b32';
    return { ...defaultPreferences, ...saved, overlay: { ...defaultPreferences.overlay, ...saved.overlay, types: { ...defaultPreferences.overlay.types, ...saved.overlay?.types } } };
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
        tx.set(ref, { hostUid: uid, memberUids: [uid], memberCount: 1, locked: false, playbackControlsEnabled: true, driftCorrection: { enabled: false, threshold: 2.5 }, createdAt: serverTimestamp(), playback });
        tx.set(memberRef(code, uid), { uid, name, joinedAt: serverTimestamp(), playback });
      });
      return code;
    } catch (error) { if (error.message !== 'ROOM_COLLISION') throw error; }
  }
  throw new Error('Could not reserve a room code. Please try again.');
}

async function joinRoom(uid, name, code) {
  const ref = roomRef(code);
  const outcome = await runTransaction(db, async (tx) => {
    const room = await tx.get(ref);
    if (!room.exists()) throw new Error('No room found with that code.');
    const data = room.data();
    if ((data.memberUids || []).includes(uid)) return { position: data.playback?.position || 0, didJoin: false };
    if (data.locked === true) throw new Error('The host has locked this room. Ask them to unlock it before you join.');
    if ((data.memberUids || []).length >= 6) throw new Error('This room is full. Rooms can have up to six people.');
    const hostPlayback = data.playback || { position: 0, duration: 0, movie: '' };
    const joinPosition = hostPlayback.position || 0;
    const command = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action: 'pause', overlayAction: 'join', position: joinPosition, by: uid, name, createdAt: serverTimestamp() };
    tx.update(ref, {
      memberUids: [...(data.memberUids || []), uid],
      memberCount: (data.memberUids || []).length + 1,
      playback: { ...hostPlayback, position: joinPosition, paused: true, updatedBy: data.hostUid, updatedAt: serverTimestamp() },
      playbackCommand: command,
    });
    tx.set(memberRef(code, uid), { uid, name, joinedAt: serverTimestamp(), playback: { position: 0, duration: 0, movie: '', paused: true, updatedAt: serverTimestamp() } });
    return { position: joinPosition, didJoin: true };
  });
  return { code, ...outcome };
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
  const [greeting, setGreeting] = useState(movieGreeting);
  const [driftThresholdDraft, setDriftThresholdDraft] = useState('2.5');
  const [preferences, setPreferences] = useState(readPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [code, setCode] = useState('');
  const [members, setMembers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [room, setRoom] = useState(null);
  const [vlc, setVlc] = useState({ installed: false, running: false, managed: false });
  const [localPlayback, setLocalPlayback] = useState(null);
  const [mediaName, setMediaName] = useState('No movie selected');
  const [busy, setBusy] = useState('');
  const [hostTransferBusy, setHostTransferBusy] = useState(false);
  const [removingMemberUid, setRemovingMemberUid] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [events, setEvents] = useState(readActivity);
  const [watchHistory, setWatchHistory] = useState(readWatchHistory);
  const lastHistoryTitleRef = useRef(readWatchHistory()[0]?.title || '');
  const roomStateRef = useRef(null);
  const memberSnapshotRef = useRef([]);
  const memberNameCacheRef = useRef(new Map());
  const deletingRoomRef = useRef(false);
  const lastSentRef = useRef(0);
  const applyingRemote = useRef(false);
  const lastAppliedCommandRef = useRef('');
  const lastAnnouncedCommandRef = useRef('');
  const lastHostUidRef = useRef('');
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
  const sessionLoggedRef = useRef(false);
  const lastManagedStatusRef = useRef(null);
  const messageSnapshotReadyRef = useRef(false);

  const driftThreshold = Math.max(2.5, Math.min(15, Number(room?.driftCorrection?.threshold) || 2.5));
  useEffect(() => { setDriftThresholdDraft(String(driftThreshold)); }, [driftThreshold]);

  useEffect(() => {
    const timer = setInterval(() => setGreeting(movieGreeting()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const logEvent = useCallback((event, actor = 'You', detail = '', severity = 'info') => {
    const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), event, actor, detail, severity };
    setEvents((current) => [entry, ...current].slice(0, 80));
  }, []);

  const persistWatchHistory = useCallback((next) => {
    localStorage.setItem('wewatch-history', JSON.stringify(next));
    setWatchHistory(next);
  }, []);

  const recordWatchHistory = useCallback((title, playedAt = Date.now(), position = 0) => {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return;
    const current = readWatchHistory();
    const latest = current[0];
    const isSamePlayback = latest && playedAt >= latest.playedAt && playedAt - latest.playedAt < 15000
      && lastHistoryTitleRef.current === latest.title;
    const next = isSamePlayback
      ? [{ ...latest, title: cleanTitle, position: Math.max(0, Number(position) || 0) }]
      : [{ title: cleanTitle, playedAt, position: Math.max(0, Number(position) || 0) }];
    lastHistoryTitleRef.current = cleanTitle;
    persistWatchHistory(next);
  }, [persistWatchHistory]);

  const saveWatchHistoryPosition = useCallback((title, position, force = false) => {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return;
    const current = readWatchHistory();
    const latest = current[0];
    if (!latest || latest.title !== cleanTitle) return;
    const nextPosition = Math.max(0, Number(position) || 0);
    if (!force && Math.abs(nextPosition - latest.position) < 5) return;
    persistWatchHistory([{ ...latest, position: nextPosition }]);
  }, [persistWatchHistory]);

  useEffect(() => {
    localStorage.setItem('wewatch-preferences', JSON.stringify(preferences));
    document.documentElement.style.setProperty('--lime', preferences.accent);
    document.documentElement.style.setProperty('--font-scale', String(preferences.fontScale));
    document.body.dataset.layout = preferences.layout;
    window.desktop?.configureOverlay?.(preferences.overlay);
  }, [preferences]);

  useEffect(() => {
    localStorage.setItem('wewatch-activity', JSON.stringify(events));
  }, [events]);

  useEffect(() => {
    localStorage.setItem('wewatch-history', JSON.stringify(watchHistory));
  }, [watchHistory]);

  useEffect(() => {
    if (!vlc.managed || !localPlayback || localPlayback.state === 'stopped') {
      if (!vlc.managed && localPlayback) saveWatchHistoryPosition(mediaName, localPlayback.time, true);
      lastHistoryTitleRef.current = '';
      return;
    }
    const actualTitle = String(localPlayback.information?.category?.meta?.title || '').trim();
    const title = actualTitle || mediaName;
    if (!title || title === 'No movie selected') return;
    if (actualTitle && actualTitle !== mediaName) setMediaName(actualTitle);
    if (title !== lastHistoryTitleRef.current) recordWatchHistory(title, Date.now(), localPlayback.time);
    else saveWatchHistoryPosition(title, localPlayback.time);
  }, [vlc.managed, localPlayback?.state, localPlayback?.time, localPlayback?.information?.category?.meta?.title, mediaName, recordWatchHistory, saveWatchHistoryPosition]);

  useEffect(() => {
    if (sessionLoggedRef.current) return;
    sessionLoggedRef.current = true;
    logEvent('App opened', name || 'You', 'We Watch session started');
  }, [logEvent, name]);

  useEffect(() => {
    if (error) logEvent('Error', name || 'You', error, 'error');
  }, [error, logEvent, name]);

  useEffect(() => {
    const previous = lastManagedStatusRef.current;
    lastManagedStatusRef.current = vlc.managed;
    if (previous === null || previous === vlc.managed) return;
    logEvent(vlc.managed ? 'VLC connected' : 'VLC disconnected', name || 'You', vlc.managed ? 'Playback controls ready' : 'Managed player connection ended', vlc.managed ? 'success' : 'warning');
  }, [vlc.managed, logEvent, name]);

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
    roomStateRef.current = null;
    memberSnapshotRef.current = [];
    memberNameCacheRef.current = new Map();
    messageSnapshotReadyRef.current = false;
    setMessages([]);
    const stopRoom = onSnapshot(roomRef(code), (snapshot) => {
      if (!snapshot.exists()) {
        const previous = roomStateRef.current;
        if (previous?.hostUid && previous.hostUid !== uid) {
          const hostName = memberNameCacheRef.current.get(previous.hostUid) || 'Host';
          window.desktop?.showPlaybackOverlay?.({ name: hostName, action: 'leave', position: previous.playback?.position || 0 });
          logEvent('Room closed', hostName, 'Host closed the room');
        }
        roomStateRef.current = null;
        if (!deletingRoomRef.current) setError('This room has ended.');
        setCode('');
        return;
      }
      const nextRoom = snapshot.data();
      const previousRoom = roomStateRef.current;
      if (previousRoom?.memberUids?.includes(uid) && !nextRoom.memberUids?.includes(uid)) {
        roomStateRef.current = nextRoom;
        setRoom(nextRoom);
        setMembers([]);
        setMessages([]);
        logEvent('Removed from room', name || 'You', 'The host removed you from the room', 'warning');
        setToast('You were removed from the room');
        setTimeout(() => setToast(''), 2400);
        setCode('');
        return;
      }
      if (previousRoom?.hostUid && previousRoom.hostUid !== nextRoom.hostUid && nextRoom.hostUid === uid) {
        setToast('You are now the host');
        setTimeout(() => setToast(''), 2200);
      }
      if (previousRoom && previousRoom.memberUids && nextRoom.memberUids) {
        const removed = previousRoom.memberUids.filter((memberUid) => !nextRoom.memberUids.includes(memberUid) && memberUid !== uid);
        removed.forEach((memberUid) => {
          const memberName = memberNameCacheRef.current.get(memberUid) || 'A member';
          window.desktop?.showPlaybackOverlay?.({ name: memberName, action: 'leave', position: previousRoom.playback?.position || 0 });
          logEvent('Member left', memberName, 'Left the room');
        });
      }
      roomStateRef.current = nextRoom;
      roomReceivedAtRef.current = Date.now();
      setRoom(nextRoom);
    }, (e) => setError(`Room connection issue: ${e.message}`));
    const stopMembers = onSnapshot(collection(db, 'rooms', code, 'members'), (snapshot) => {
      const nextMembers = snapshot.docs.map((d) => ({ ...d.data(), receivedAt: Date.now() }));
      memberSnapshotRef.current = nextMembers;
      nextMembers.forEach((member) => memberNameCacheRef.current.set(member.uid, member.name));
      setMembers(nextMembers);
    });
    const messageQuery = query(collection(db, 'rooms', code, 'messages'), orderBy('createdAt', 'asc'), limitToLast(50));
    const stopMessages = onSnapshot(messageQuery, { includeMetadataChanges: true }, (snapshot) => {
      const initialServerSnapshot = !snapshot.metadata.fromCache && !messageSnapshotReadyRef.current;
      if (initialServerSnapshot) messageSnapshotReadyRef.current = true;
      else if (messageSnapshotReadyRef.current) {
        snapshot.docChanges().filter((change) => change.type === 'added').forEach((change) => {
          const message = change.doc.data();
          if (message.uid === uid) return;
          const actor = message.name || 'A viewer';
          if (message.type === 'reaction' && message.reaction) {
            window.desktop?.showPlaybackOverlay?.({ name: actor, action: 'reaction', reaction: message.reaction });
            logEvent('Reaction', actor, message.reaction);
          } else if (message.type === 'chat' && message.text) {
            window.desktop?.showPlaybackOverlay?.({ name: actor, action: 'chat', text: message.text });
            logEvent('Chat message', actor, message.text);
          }
        });
      }
      setMessages(snapshot.docs.map((message) => ({ id: message.id, ...message.data() })));
    }, (e) => setError(`Room chat connection issue: ${e.message}`));
    return () => { stopRoom(); stopMembers(); stopMessages(); };
  }, [code, uid, name, logEvent]);

  const sendRoomMessage = async (type, value) => {
    if (!code || !uid) return false;
    const message = type === 'chat' ? String(value || '').trim().slice(0, 500) : '';
    const reaction = type === 'reaction' ? String(value || '') : '';
    if ((type === 'chat' && !message) || (type === 'reaction' && !['🍿', '❤️', '😂', '👏', '🔥'].includes(reaction))) return false;
    try {
      const actor = name.trim().slice(0, 24) || 'You';
      await addDoc(collection(db, 'rooms', code, 'messages'), {
        uid,
        name: actor,
        type,
        ...(type === 'chat' ? { text: message } : { reaction }),
        createdAt: serverTimestamp(),
      });
      if (type === 'chat') {
        window.desktop?.showPlaybackOverlay?.({ name: actor, action: 'chat', text: message });
        logEvent('Chat message', actor, message);
      } else {
        window.desktop?.showPlaybackOverlay?.({ name: actor, action: 'reaction', reaction });
        logEvent('Reaction', actor, reaction);
      }
      return true;
    } catch (e) {
      setError(`Couldn't send ${type === 'chat' ? 'message' : 'reaction'}: ${e.message}`);
      return false;
    }
  };

  const leaveRoom = async () => {
    if (!code || !uid) { setCode(''); return; }
    setBusy('leave');
    setError('');
    deletingRoomRef.current = true;
    try {
      await exitRoom(code, uid);
      window.desktop?.showPlaybackOverlay?.({ name: name || 'You', action: 'leave', position: localPlayback?.time || 0 });
      logEvent(isHost ? 'Room closed' : 'Left room', name || 'You', isHost ? 'Closed the room for everyone' : 'Left the room');
      setMembers([]);
      setRoom(null);
      roomStateRef.current = null;
      memberSnapshotRef.current = [];
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
    const displayPosition = position ?? localPlayback?.time ?? 0;
    const command = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action, by: uid, name: name || 'You', overlayPosition: displayPosition, createdAt: serverTimestamp() };
    if (position !== undefined) command.position = position;
    window.desktop?.showPlaybackOverlay?.({ name: name || 'You', action, position: displayPosition });
    const verb = action === 'seek' ? 'Sought to' : action === 'pause' ? 'Paused at' : 'Played at';
    logEvent(action === 'seek' ? 'Seek' : 'Playback', name || 'You', `${verb} ${clockFmt(displayPosition)}`);
    return updateDoc(roomRef(code), { playbackCommand: command });
  }, [code, uid, name, localPlayback?.time, logEvent]);

  useEffect(() => {
    initializedPlaybackRoomRef.current = '';
    lastAppliedCommandRef.current = '';
    lastAnnouncedCommandRef.current = '';
    lastHostUidRef.current = '';
    initialCommandRoomRef.current = '';
    lastLocalSampleRef.current = null;
  }, [code]);

  useEffect(() => {
    if (!code || !room || initialCommandRoomRef.current === code) return;
    initialCommandRoomRef.current = code;
    lastAppliedCommandRef.current = room.playbackCommand?.id || '';
    lastAnnouncedCommandRef.current = room.playbackCommand?.id || '';
  }, [code, room]);

  useEffect(() => {
    if (!remotePlayback || !code || !uid || remotePlayback.updatedBy === uid || !vlc.managed || applyingRemote.current) return;
    const hostChanged = Boolean(lastHostUidRef.current && lastHostUidRef.current !== room?.hostUid);
    if (room?.hostUid) lastHostUidRef.current = room.hostUid;
    const initialRoomSync = initializedPlaybackRoomRef.current !== code || hostChanged;
    initializedPlaybackRoomRef.current = code;
    const autoDriftCorrection = room?.driftCorrection?.enabled === true;
    const followHost = initialRoomSync || !room?.playbackControlsEnabled || autoDriftCorrection;
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
          const driftLimit = !initialRoomSync && autoDriftCorrection ? driftThreshold : remotePlayback.paused && stateMismatch ? 0.8 : 1.5;
          if (followHost && Math.abs((state.time || 0) - target) > driftLimit) await window.desktop.control('seek', target);
        }
      } catch {}
      setTimeout(() => { applyingRemote.current = false; }, 1500);
    };
    apply();
  }, [code, room?.hostUid, room?.playbackControlsEnabled, room?.driftCorrection?.enabled, driftThreshold, remotePlayback?.position, remotePlayback?.paused, remotePlayback?.updatedBy, localPlayback?.time, localPlayback?.state, vlc.managed, uid]);

  useEffect(() => {
    const command = room?.playbackCommand;
    if (!code || !uid || !command?.id || command.by === uid) return;
    if (!['play', 'pause', 'seek', 'sync', 'movie'].includes(command.action)) return;
    if (lastAnnouncedCommandRef.current !== command.id) {
      lastAnnouncedCommandRef.current = command.id;
      const actor = members.find((member) => member.uid === command.by);
      const actorName = actor?.name || command.name || (command.by === room?.hostUid ? 'Host' : 'Member');
      const action = command.overlayAction || command.action;
      const position = command.position ?? command.overlayPosition ?? localPlayback?.time ?? 0;
      window.desktop?.showPlaybackOverlay?.({ name: actorName, action, position, fileName: command.fileName });
      const eventLabel = action === 'join' ? 'Member joined' : action === 'leave' ? 'Member left' : action === 'movie' ? 'Movie selected' : action === 'seek' ? 'Seek' : 'Playback';
      const detail = action === 'movie' ? command.fileName || 'Movie selected' : action === 'join' ? 'Joined the room' : action === 'leave' ? 'Left the room' : `${action === 'seek' ? 'Sought to' : action === 'pause' ? 'Paused at' : 'Played at'} ${clockFmt(position)}`;
      logEvent(eventLabel, actorName, detail);
    }
    if (command.action === 'movie') return;
    if (!vlc.managed || lastAppliedCommandRef.current === command.id) return;
    lastAppliedCommandRef.current = command.id;
    const joinedAt = members.find((member) => member.uid === uid)?.joinedAt?.toMillis?.();
    const commandAt = command.createdAt?.toMillis?.();
    if (joinedAt && commandAt && commandAt < joinedAt) return;
    applyingRemote.current = true;
    const applyCommand = async () => {
      if (command.action === 'sync') {
        const age = Math.min(3, Math.max(0, (Date.now() - (command.createdAt?.toMillis?.() || Date.now())) / 1000));
        const target = (command.position || 0) + (command.paused ? 0 : age);
        await window.desktop.control('seek', target);
        await window.desktop.control(command.paused ? 'pause' : 'play');
      } else {
        if (command.action === 'pause' && typeof command.position === 'number') await window.desktop.control('seek', command.position);
        await window.desktop.control(command.action, command.position);
      }
      await refreshVlc();
    };
    applyCommand().catch((e) => setError(`Playback sync failed: ${e.message}`)).finally(() => {
      setTimeout(() => { applyingRemote.current = false; }, 1500);
    });
  }, [code, uid, members, room?.hostUid, room?.playbackCommand?.id, room?.playbackCommand?.by, room?.playbackCommand?.action, room?.playbackCommand?.fileName, room?.playbackCommand?.paused, room?.playbackCommand?.overlayAction, room?.playbackCommand?.position, room?.playbackCommand?.overlayPosition, room?.playbackCommand?.createdAt, localPlayback?.time, vlc.managed, refreshVlc, logEvent]);

  useEffect(() => {
    if (!localPlayback || !vlc.managed) return;
    const current = { time: localPlayback.time || 0, state: localPlayback.state, at: Date.now() };
    const previous = lastLocalSampleRef.current;
    lastLocalSampleRef.current = current;
    if (!previous || applyingRemote.current) return;
    const actionChanged = (previous.state === 'playing' && current.state === 'paused')
      || (previous.state === 'paused' && current.state === 'playing')
      || (previous.state === 'stopped' && current.state === 'playing');
    const canControl = !code || isHost || room?.playbackControlsEnabled;
    if (actionChanged && canControl) {
      const action = current.state === 'playing' ? 'play' : 'pause';
      const recent = lastLocalCommandRef.current;
      if (recent?.action === action && current.at - recent.at < 5000) lastLocalCommandRef.current = null;
      else if (code) publishPlaybackCommand(action).catch((e) => setError(`Couldn't sync playback: ${e.message}`));
      else {
        window.desktop?.showPlaybackOverlay?.({ name: name || 'You', action, position: current.time });
        logEvent('Playback', name || 'You', `${action === 'pause' ? 'Paused at' : 'Played at'} ${clockFmt(current.time)}`);
      }
    }
    if (!canControl) return;
    const elapsed = Math.max(0, (current.at - previous.at) / 1000);
    const expectedAdvance = previous.state === 'playing' ? elapsed : 0;
    const seekDelta = current.time - previous.time - expectedAdvance;
    if (Math.abs(seekDelta) < 1.75) return;
    if (code) publishPlaybackCommand('seek', current.time).catch((e) => setError(`Couldn't sync seek: ${e.message}`));
    else {
      window.desktop?.showPlaybackOverlay?.({ name: name || 'You', action: 'seek', position: current.time });
      logEvent('Seek', name || 'You', `Sought to ${clockFmt(current.time)}`);
    }
  }, [code, uid, name, isHost, room?.playbackControlsEnabled, localPlayback?.time, localPlayback?.state, vlc.managed, publishPlaybackCommand, logEvent]);

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
      let joinedCode;
      let joinedPosition = 0;
      if (action === 'create') joinedCode = await createRoom(uid, name.trim(), vlc.managed ? localPlayback : null);
      else {
        const joined = await joinRoom(uid, name.trim(), value);
        joinedCode = joined.code;
        joinedPosition = joined.position;
        if (joined.didJoin) window.desktop?.showPlaybackOverlay?.({ name: name.trim(), action: 'join', position: joined.position });
      }
      if (action === 'create' && vlc.managed) {
        try {
          const wasPlaying = localPlayback?.state === 'playing';
          await window.desktop.control('pause');
          if (wasPlaying) window.desktop.showPlaybackOverlay?.({ name: name.trim(), action: 'pause', position: localPlayback?.time || 0 });
          await refreshVlc();
        }
        catch (e) { setError(`Room created, but VLC could not be paused: ${e.message}`); }
      }
      logEvent(action === 'create' ? 'Room created' : 'Joined room', name.trim(), action === 'create' ? `Room ${joinedCode} · member controls enabled` : `Room ${joinedCode} · host position ${clockFmt(joinedPosition)}`);
      setCode(joinedCode); setCodeInput('');
    } catch (e) { setError(e.message || 'Something went wrong. Please try again.'); }
    finally { setBusy(''); }
  };

  const statusLabel = vlc.managed ? 'VLC connected' : vlc.running ? 'VLC running · not connected' : vlc.installed ? 'VLC installed · not running' : 'VLC not installed';
  const peerPos = peerPlayback ? (peerPlayback.position || 0) : 0;
  const ownPos = localPlayback?.time || 0;
  const drift = peerPlayback ? ownPos - peerPos : null;
  const driftLabel = drift === null ? 'Waiting for their player' : Math.abs(drift) <= 2.5 ? 'In sync' : `${isHost ? 'Guest' : 'Host'} ${fmt(Math.abs(drift))} ${drift > 0 ? 'behind' : 'ahead'}`;
  const copyCode = async () => { await navigator.clipboard.writeText(code); logEvent('Invite copied', name || 'You', `Room ${code}`); setToast('Room code copied'); setTimeout(() => setToast(''), 1800); };
  const startVlc = async () => { setError(''); try { await window.desktop.startVlc(); logEvent('VLC started', name || 'You', 'Started the managed player'); refreshVlc(); } catch (e) { setError(e.message); } };
  const chooseMovie = async () => { setError(''); try { const picked = await window.desktop.chooseMovie(); if (picked) { const playedAt = Date.now(); setMediaName(picked.name); recordWatchHistory(picked.name, playedAt, 0); logEvent('Movie selected', name || 'You', picked.name); window.desktop.showPlaybackOverlay?.({ name: name || 'You', action: 'movie', fileName: picked.name, position: localPlayback?.time || 0 }); if (code) await updateDoc(roomRef(code), { playbackCommand: { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action: 'movie', by: uid, name: name || 'You', fileName: picked.name, position: localPlayback?.time || 0, createdAt: serverTimestamp() } }); refreshVlc(); } } catch (e) { setError(e.message); } };
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
      else if (!code) {
        const position = current?.time ?? localPlayback?.time ?? 0;
        window.desktop.showPlaybackOverlay?.({ name: name || 'You', action, position });
        logEvent('Playback', name || 'You', `${action === 'pause' ? 'Paused at' : 'Played at'} ${clockFmt(position)}`);
      }
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
      logEvent('Synced with host', name || 'You', `At ${clockFmt(target)} · ${shouldPlay ? 'playing' : 'paused'}`);
      setToast('Synced with the host'); setTimeout(() => setToast(''), 1800);
    } catch (e) { setError(e.message); }
    finally { setTimeout(() => { applyingRemote.current = false; }, 1500); }
  };
  const syncMembersToHost = async () => {
    if (!isHost || !code) return;
    if (!vlc.managed) { setError('Start a movie in VLC before syncing members.'); return; }
    try {
      const current = await window.desktop.readPlayback();
      if (!current) { setError('Could not read the host’s current VLC playback.'); return; }
      const paused = current.state !== 'playing';
      const position = Number(current.time) || 0;
      const command = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        action: 'sync',
        overlayAction: 'seek',
        by: uid,
        name: name || 'You',
        position,
        paused,
        overlayPosition: position,
        createdAt: serverTimestamp(),
      };
      await updateDoc(roomRef(code), { playbackCommand: command });
      logEvent('Members synced', name || 'You', `At ${clockFmt(position)} · ${paused ? 'paused' : 'playing'}`);
      setToast('Members synced to you'); setTimeout(() => setToast(''), 1800);
    } catch (e) { setError(`Couldn't sync members: ${e.message}`); }
  };
  const toggleMemberControls = async () => {
    if (!isHost || !code) return;
    try {
      const enabled = !room.playbackControlsEnabled;
      await updateDoc(roomRef(code), { playbackControlsEnabled: enabled });
      logEvent('Room controls changed', name || 'You', `Member playback ${enabled ? 'enabled' : 'disabled'}`);
    }
    catch (e) { setError(e.message); }
  };
  const toggleRoomLock = async () => {
    if (!isHost || !code) return;
    const locked = room?.locked !== true;
    try {
      await updateDoc(roomRef(code), { locked });
      logEvent(locked ? 'Room locked' : 'Room unlocked', name || 'You', locked ? 'New members can no longer join' : 'The room is open to new members');
      setToast(locked ? 'Room locked' : 'Room unlocked');
      setTimeout(() => setToast(''), 2200);
    } catch (e) { setError(`Couldn't ${locked ? 'lock' : 'unlock'} the room: ${e.message}`); }
  };
  const toggleDriftCorrection = async () => {
    if (!isHost || !code) return;
    const enabled = room?.driftCorrection?.enabled !== true;
    try {
      await updateDoc(roomRef(code), { driftCorrection: { enabled, threshold: driftThreshold } });
      logEvent('Drift correction changed', name || 'You', `Automatic correction ${enabled ? 'enabled' : 'disabled'} · ${driftThreshold}s threshold`);
    } catch (e) { setError(`Couldn't update drift correction: ${e.message}`); }
  };
  const saveDriftThreshold = async () => {
    if (!isHost || !code) return;
    const value = Number(driftThresholdDraft);
    if (!Number.isFinite(value)) { setDriftThresholdDraft(String(driftThreshold)); return; }
    const threshold = Math.max(2.5, Math.min(15, Math.round(value * 2) / 2));
    try {
      await updateDoc(roomRef(code), { driftCorrection: { enabled: room?.driftCorrection?.enabled === true, threshold } });
      setDriftThresholdDraft(String(threshold));
      logEvent('Drift threshold changed', name || 'You', `Correction starts at ${threshold}s of drift`);
    } catch (e) { setError(`Couldn't save drift threshold: ${e.message}`); }
  };
  const transferHost = async (targetUid) => {
    if (!isHost || !code || targetUid === uid || hostTransferBusy || removingMemberUid) return;
    const target = members.find((member) => member.uid === targetUid);
    if (!target) return;
    setHostTransferBusy(true);
    try {
      await updateDoc(roomRef(code), { hostUid: targetUid });
      logEvent('Host transferred', name || 'You', `Transferred room host to ${target.name || 'a member'}`);
      setToast(`${target.name || 'Member'} is now the host`); setTimeout(() => setToast(''), 2200);
    } catch (e) { setError(`Couldn't transfer host: ${e.message}`); }
    finally { setHostTransferBusy(false); }
  };
  const removeMember = async (targetUid) => {
    if (!isHost || !code || targetUid === uid || removingMemberUid || hostTransferBusy) return;
    const target = members.find((member) => member.uid === targetUid);
    if (!target) return;
    const targetName = target.name || 'this member';
    if (!window.confirm(`Remove ${targetName} from this room? They can join again with the room code.`)) return;
    setRemovingMemberUid(targetUid);
    try {
      await runTransaction(db, async (transaction) => {
        const ref = roomRef(code);
        const currentRoom = await transaction.get(ref);
        if (!currentRoom.exists()) throw new Error('This room has already ended.');
        const data = currentRoom.data();
        if (data.hostUid !== uid) throw new Error('Only the current host can remove a member.');
        if (targetUid === data.hostUid) throw new Error('The host cannot remove themselves.');
        const memberUids = data.memberUids || [];
        if (!memberUids.includes(targetUid)) throw new Error('This member is no longer in the room.');
        const targetRef = memberRef(code, targetUid);
        const targetDocument = await transaction.get(targetRef);
        const remainingUids = memberUids.filter((memberUid) => memberUid !== targetUid);
        transaction.update(ref, { memberUids: remainingUids, memberCount: remainingUids.length });
        if (targetDocument.exists()) transaction.delete(targetRef);
      });
      logEvent('Member removed', name || 'You', `Removed ${targetName} from the room`, 'warning');
      setToast(`${targetName} was removed from the room`);
      setTimeout(() => setToast(''), 2200);
    } catch (e) { setError(`Couldn't remove ${targetName}: ${e.message}`); }
    finally { setRemovingMemberUid(''); }
  };
  const clearActivity = () => setEvents([]);
  const saveSettings = (next) => setPreferences((current) => ({ ...current, ...next }));
  const progress = localPlayback?.length ? Math.min(100, ((localPlayback.time || 0) / localPlayback.length) * 100) : 0;
  const title = localPlayback?.information?.category?.meta?.title || mediaName;
  const welcomeMessage = name.trim() ? `Welcome, ${name.trim()}!` : 'A little closer, one frame at a time.';

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#home" aria-label="We Watch home"><img className="brand-logo" src="/we-watch.png" alt="" /><span className="brand-word">We Watch</span><span className="brand-beta">WATCH CLUB</span></a>
      <div className="top-center"><span className="live-dot" /> YOUR PRIVATE LITTLE CINEMA</div>
      <div className="top-actions"><span className="your-name">{name || 'Your profile'}</span><button className="icon-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings2 size={20} /><span>Settings</span></button></div>
    </header>
    <div className="main-layout" id="home">
      <section className="content">
        <div className="eyebrow"><span>WE WATCH PRESENTS</span><i /></div>
        <div className="intro"><div><h1>{greeting},<br /><em>together.</em></h1><p className="subtitle">{welcomeMessage}</p></div><div className="heading-note"><span className="ticket-stub">ADMIT<br />TWO</span></div></div>
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
        </div> : <RoomView code={code} uid={uid} members={members} messages={messages} onSendRoomMessage={sendRoomMessage} peer={peer} name={name} room={room} isHost={isHost} hostTransferBusy={hostTransferBusy} removingMemberUid={removingMemberUid} onTransferHost={transferHost} onRemoveMember={removeMember} peerPlayback={peerPlayback} pingMs={room?.ping?.ms} driftLabel={driftLabel} driftThreshold={driftThreshold} driftThresholdDraft={driftThresholdDraft} onDriftThresholdChange={setDriftThresholdDraft} onSaveDriftThreshold={saveDriftThreshold} onToggleDriftCorrection={toggleDriftCorrection} onToggleRoomLock={toggleRoomLock} copyCode={copyCode} onLeave={leaveRoom} leaving={busy === 'leave'} onToggleControls={toggleMemberControls} onSyncHost={syncWithHost} onSyncMembers={syncMembersToHost} />}

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
      <aside className="side-rail activity-rail">
        <div className="activity-header"><span className="section-kicker">LOCAL DEBUG HISTORY</span><div className="activity-title-row"><div><h2>Activity log</h2><p>Playback, room events, and errors</p></div><button className="activity-clear" onClick={clearActivity} disabled={!events.length}>Clear</button></div><div className="activity-summary"><span><i /> Captured on this device</span><b>{events.length} / 80</b></div></div>
        <section className="watch-history" aria-label="Recently played"><div className="watch-history-heading"><span className="section-kicker">RECENTLY PLAYED</span></div>{watchHistory.length ? <ul>{watchHistory.slice(0, 1).map((entry) => <li key={entry.playedAt}><b title={entry.title}>{entry.title}</b><time title="Last playback position">{clockFmt(entry.position)}</time></li>)}</ul> : <p>Movies you select will appear here with their last playback position.</p>}</section>
        <div className="activity-list" aria-live="polite">
          {!events.length && <div className="activity-empty"><Activity size={22} /><b>No events yet</b><span>App actions will appear here with their time and user.</span></div>}
          {events.map((entry) => <article className={`activity-entry ${entry.severity || 'info'}`} key={entry.id}><time dateTime={new Date(entry.at).toISOString()}>{wallClockFmt(entry.at)}</time><span className="activity-marker" /><div className="activity-entry-copy"><div><b>{entry.actor}</b><strong>{entry.event}</strong></div>{entry.detail && <p>{entry.detail}</p>}</div></article>)}
        </div>
      </aside>
    </div>
    <div className="window-footer"><span><Activity size={15} /> {authReady ? 'Connected to the watch club' : 'Connecting to the watch club'}</span><span>WE WATCH DESKTOP <i>·</i> 0.1.0 <i>·</i> Made with ❤️ by Natu</span></div>
    {settingsOpen && <SettingsPanel name={name} preferences={preferences} onNameChange={setName} onChange={saveSettings} onClose={async () => { localStorage.setItem('wewatch-name', name.trim()); if (code && uid) updateDoc(memberRef(code, uid), { name: name.trim() }).catch(() => {}); setSettingsOpen(false); }} />}
    {toast && <div className="toast"><Check size={18} />{toast}</div>}
  </main>;
}

function RoomView({ code, uid, members, messages, onSendRoomMessage, peer, name, room, isHost, hostTransferBusy, removingMemberUid, onTransferHost, onRemoveMember, peerPlayback, pingMs, driftLabel, driftThreshold, driftThresholdDraft, onDriftThresholdChange, onSaveDriftThreshold, onToggleDriftCorrection, onToggleRoomLock, copyCode, onLeave, leaving, onToggleControls, onSyncHost, onSyncMembers }) {
  const [chatDraft, setChatDraft] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const chatListRef = useRef(null);
  const host = members.find((member) => member.uid === room?.hostUid);
  const participants = [...members];
  if (!participants.some((member) => member.uid === uid)) participants.unshift({ uid, name });
  const memberOrder = new Map((room?.memberUids || []).map((memberUid, index) => [memberUid, index]));
  participants.sort((a, b) => (memberOrder.get(a.uid) ?? Number.MAX_SAFE_INTEGER) - (memberOrder.get(b.uid) ?? Number.MAX_SAFE_INTEGER));
  const formatPosition = (playback) => playback ? `${fmt(playback.position || 0)} / ${fmt(playback.duration || 0)}` : 'No movie playing';
  const thresholdDirty = Number(driftThresholdDraft) !== driftThreshold;
  const reactions = ['🍿', '❤️', '😂', '👏', '🔥'];
  const submitMessage = async (event) => {
    event.preventDefault();
    if (!chatDraft.trim() || chatSending) return;
    setChatSending(true);
    try { if (await onSendRoomMessage('chat', chatDraft)) setChatDraft(''); }
    finally { setChatSending(false); }
  };
  const sendReaction = async (reaction) => {
    if (chatSending) return;
    setChatSending(true);
    try { await onSendRoomMessage('reaction', reaction); }
    finally { setChatSending(false); }
  };
  useEffect(() => {
    if (chatListRef.current) chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
  }, [messages]);
  return <section className="active-room panel"><div className="room-live"><div><div className="section-kicker">YOUR PRIVATE ROOM · {members.length || 1}/6 WATCHING</div><h2>You're in. <em>Invite your people.</em></h2></div><button className="leave-btn" disabled={leaving} onClick={onLeave}><X size={18} /> {leaving ? (isHost ? 'Closing room…' : 'Leaving room…') : (isHost ? 'Close room for everyone' : 'Leave room')}</button></div><div className="room-invite"><div><span>SHARE THIS SIX-DIGIT ROOM CODE</span><strong>{code.slice(0, 3)} <b>{code.slice(3)}</b></strong></div><button className="copy-btn" onClick={copyCode}><Copy size={18} /> Copy invite code</button></div>
    <div className="current-user-banner"><span className="avatar current-user-avatar">{name.trim().slice(0, 1).toUpperCase() || 'Y'}</span><div><small>YOU'RE WATCHING AS</small><b>{name || 'Your profile'}</b></div><span className="current-user-role">{isHost ? 'HOST' : 'MEMBER'} · YOU</span></div>
    <div className="room-members">{participants.map((member) => { const isCurrentUser = member.uid === uid; const memberIsHost = member.uid === room?.hostUid; const hostActionBusy = hostTransferBusy || Boolean(removingMemberUid); return <div className={`room-member ${isCurrentUser ? 'current-user-row' : ''}`} key={member.uid}><span className={`avatar ${isCurrentUser ? '' : 'friend'}`}>{member.name?.slice(0, 1).toUpperCase() || '＋'}</span><div><b>{member.name || (isCurrentUser ? 'You' : 'Guest')}</b><small>{memberIsHost ? 'HOST' : 'MEMBER'}{isCurrentUser ? ' · YOU' : ''}{member.playback?.paused === false ? ' · PLAYING' : ''}</small><small className="member-title"><Film size={11} /> {member.playback?.movie || 'Movie not selected'}</small><small className="member-movie">{formatPosition(member.playback)}</small></div>{isHost && !isCurrentUser ? <div className="member-host-actions"><button className="make-host-btn" disabled={hostActionBusy} onClick={() => onTransferHost(member.uid)} title={`Transfer host to ${member.name || 'this member'}`}>Make host</button><button className="remove-member-btn" disabled={hostActionBusy} onClick={() => onRemoveMember(member.uid)} aria-label={`Remove ${member.name || 'member'} from the room`} title={`Remove ${member.name || 'this member'} from the room`}><X size={14} /> Remove</button></div> : <span className="member-ready"><Check size={12} /> {isCurrentUser ? 'YOU' : 'HERE'}</span>}</div>; })}</div>
    <div className="room-controls">
      <div className="room-control-info"><span className="ping-tag"><Gauge size={14} /> {pingMs ? `${pingMs} ms relay ping` : 'Measuring room ping…'}</span><span className={`drift-tag ${driftLabel === 'In sync' ? 'good' : ''}`}>{driftLabel}</span></div>
      {isHost ? <div className="room-host-controls">
        <div className="room-setting-row"><div className="room-setting-copy"><b>Lock room</b><small>{room?.locked ? 'New members cannot join with the room code.' : 'Allow people with the room code to join.'}</small></div><button className={`control-toggle ${room?.locked ? 'enabled' : ''}`} aria-pressed={room?.locked === true} onClick={onToggleRoomLock}><span className="toggle-switch"><i /></span> <b>{room?.locked ? 'LOCKED' : 'OPEN'}</b></button></div>
        <div className="room-setting-row"><div className="room-setting-copy"><b>Automatic drift correction</b><small>Follow your playback when a member drifts past the chosen threshold.</small></div><button className={`control-toggle ${room?.driftCorrection?.enabled ? 'enabled' : ''}`} aria-pressed={room?.driftCorrection?.enabled === true} onClick={onToggleDriftCorrection}><span className="toggle-switch"><i /></span> <b>{room?.driftCorrection?.enabled ? 'ON' : 'OFF'}</b></button></div>
        {room?.driftCorrection?.enabled && <div className="room-setting-row"><label className="room-setting-copy" htmlFor="drift-threshold"><b>Correction threshold</b><small>Members are corrected once drift exceeds this value.</small></label><div className="threshold-input"><input id="drift-threshold" type="number" min="2.5" max="15" step="0.5" value={driftThresholdDraft} onChange={(event) => onDriftThresholdChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onSaveDriftThreshold(); }} aria-label="Automatic drift correction threshold in seconds" /><span>sec</span><button className="threshold-save" disabled={!thresholdDirty || !Number.isFinite(Number(driftThresholdDraft))} onClick={onSaveDriftThreshold}>Save</button></div></div>}
        <div className="room-host-actions"><button className="sync-host-btn" onClick={onSyncMembers}><RefreshCw size={15} /> Sync members to host</button><button className={`control-toggle ${room?.playbackControlsEnabled ? 'enabled' : ''}`} onClick={onToggleControls}><span className="toggle-switch"><i /></span> Member playback controls <b>{room?.playbackControlsEnabled ? 'ON' : 'OFF'}</b></button></div>
      </div> : <button className="sync-host-btn" onClick={onSyncHost}><RefreshCw size={15} /> Sync with host</button>}
    </div>
    <div className="room-hint"><LockKeyhole size={14} /> {isHost ? `Automatic drift correction is ${room?.driftCorrection?.enabled ? `on at ${driftThreshold}s` : 'off'}. Choose whether your guest can control playback.` : `The host is ${host?.name || 'your friend'}. ${room?.playbackControlsEnabled ? 'You can control playback.' : 'Playback controls are managed by the host.'} ${room?.driftCorrection?.enabled ? `Automatic correction is on at ${driftThreshold}s.` : ''}`}</div>
    <section className="room-chat" aria-label="Room chat"><div className="room-chat-heading"><div><span className="section-kicker">WATCHING TOGETHER</span><h3>Room chat</h3></div><span className="chat-count">{messages.length} / 50</span></div>
      <div className="reaction-picker" aria-label="Send a quick reaction">{reactions.map((reaction) => <button key={reaction} type="button" disabled={chatSending} onClick={() => sendReaction(reaction)} aria-label={`Send ${reaction} reaction`} title={`Send ${reaction}`}>{reaction}</button>)}</div>
      <div className="chat-message-list" ref={chatListRef} aria-live="polite">{messages.length ? messages.map((message) => <article className={`chat-message ${message.uid === uid ? 'mine' : ''} ${message.type === 'reaction' ? 'reaction-message' : ''}`} key={message.id}><div className="chat-message-meta"><b>{message.name || 'Viewer'}</b><time>{wallClockFmt(message.createdAt?.toMillis?.() || Date.now())}</time></div>{message.type === 'reaction' ? <p className="chat-reaction">{message.reaction}</p> : <p>{message.text}</p>}</article>) : <p className="chat-empty">Say hello, or send a reaction to the room.</p>}</div>
      <form className="chat-composer" onSubmit={submitMessage}><input value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} maxLength={500} placeholder="Message everyone in the room…" aria-label="Room chat message" /><button type="submit" disabled={chatSending || !chatDraft.trim()} aria-label="Send message"><ArrowUpRight size={18} /></button></form>
    </section></section>;
}

function SettingsPanel({ name, preferences, onNameChange, onChange, onClose }) {
  const swatches = ['#bc4b32', '#355c4d', '#416b86', '#7d5a83', '#bd6670', '#cf8b3d'];
  return <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="settings-head"><div className="settings-heading-icon"><SlidersHorizontal size={21} /></div><div><span className="section-kicker">YOUR WATCH SPACE</span><h2 id="settings-title">Settings</h2></div><button className="settings-close" onClick={onClose} aria-label="Close settings"><X size={20} /></button></div>
    <div className="setting-group"><label className="setting-label"><Users size={15} /> Profile</label><div className="setting-row"><div><b>Display name</b><small>This is how you appear in rooms.</small></div><input className="settings-name" maxLength={24} value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Your name" /></div></div>
    <div className="setting-group"><label className="setting-label"><Type size={17} /> Appearance</label><div className="font-samples" aria-label="Typography samples"><div className="font-sample-display"><small>HEADLINES · PLAYFAIR DISPLAY</small><span>Movie night, together.</span></div><div className="font-sample-reading"><small>READING · DM SANS</small><span>Settle in. Your movie is ready.</span></div><div className="font-sample-utility"><small>DETAILS · DM MONO</small><span>ROOM CODE  123 456</span></div></div><div className="setting-row"><div><b>Text size</b><small>Scale text and interface icons from 90% to 200%.</small></div><div className="size-control"><span>A</span><input aria-label="Text size" type="range" min="0.9" max="2" step="0.05" value={preferences.fontScale} onChange={(event) => onChange({ fontScale: Number(event.target.value) })} /><strong>A</strong><em>{Math.round(preferences.fontScale * 100)}%</em></div></div>
    <div className="setting-row"><div><b>Layout spacing</b><small>Choose how much room the panels get.</small></div><div className="layout-options">{['compact', 'comfortable', 'spacious'].map((layout) => <button key={layout} className={preferences.layout === layout ? 'selected' : ''} onClick={() => onChange({ layout })}><LayoutDashboard size={14} />{layout}</button>)}</div></div>
    <div className="setting-row"><div><b>Accent color</b><small>Personalize your We Watch highlights.</small></div><div className="color-options">{swatches.map((color) => <button key={color} style={{ '--swatch': color }} className={preferences.accent.toLowerCase() === color ? 'selected' : ''} onClick={() => onChange({ accent: color })} aria-label={`Use ${color}`} />)}<label className="custom-color" title="Choose a custom color"><input type="color" value={preferences.accent} onChange={(event) => onChange({ accent: event.target.value })} /><Plus size={15} /></label></div></div></div>
    <div className="setting-group"><label className="setting-label"><Captions size={17} /> VLC activity overlay</label>
      <div className="setting-row"><div><b>Show playback notices</b><small>Display who played, paused, or sought on top of VLC.</small></div><label className="overlay-toggle"><input type="checkbox" checked={preferences.overlay.enabled} onChange={(event) => onChange({ overlay: { ...preferences.overlay, enabled: event.target.checked } })} /><span>{preferences.overlay.enabled ? 'On' : 'Off'}</span></label></div>
      <fieldset className="overlay-options" disabled={!preferences.overlay.enabled}>
      <div className="overlay-type-list"><div className="section-kicker">OVERLAY TYPES</div>{[
        ['playback', 'Playback updates', 'Movie selected, play, pause, and seek notices.'],
        ['roomActivity', 'Room activity', 'When members join or leave the room.'],
        ['chat', 'Chat messages', 'Messages sent in the room chat.'],
        ['reactions', 'Reactions', 'Quick reactions sent by members.'],
      ].map(([type, label, description]) => <div className="setting-row" key={type}><div><b>{label}</b><small>{description}</small></div><label className="overlay-toggle"><input type="checkbox" checked={preferences.overlay.types[type]} onChange={(event) => onChange({ overlay: { ...preferences.overlay, types: { ...preferences.overlay.types, [type]: event.target.checked } } })} /><span>{preferences.overlay.types[type] ? 'On' : 'Off'}</span></label></div>)}</div>
      <div className="setting-row"><div><b>Position</b><small>Choose a VLC window corner or set an exact position.</small></div><select className="overlay-select" value={preferences.overlay.position} onChange={(event) => onChange({ overlay: { ...preferences.overlay, position: event.target.value } })}><option value="top-right">Top right</option><option value="top-left">Top left</option><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option><option value="custom">Custom position</option></select></div>
      {preferences.overlay.position === 'custom' && <><div className="setting-row"><div><b>Horizontal position</b><small>Move from left to right across the VLC window.</small></div><div className="overlay-range"><input aria-label="Overlay horizontal position" type="range" min="0" max="100" value={preferences.overlay.customX} onChange={(event) => onChange({ overlay: { ...preferences.overlay, customX: Number(event.target.value) } })} /><em>{preferences.overlay.customX}%</em></div></div><div className="setting-row"><div><b>Vertical position</b><small>Move from top to bottom across the VLC window.</small></div><div className="overlay-range"><input aria-label="Overlay vertical position" type="range" min="0" max="100" value={preferences.overlay.customY} onChange={(event) => onChange({ overlay: { ...preferences.overlay, customY: Number(event.target.value) } })} /><em>{preferences.overlay.customY}%</em></div></div></>}
      <div className="setting-row"><div><b>Display duration</b><small>How long each notice stays visible.</small></div><div className="overlay-range"><input aria-label="Overlay display duration" type="range" min="1000" max="6000" step="250" value={preferences.overlay.duration} onChange={(event) => onChange({ overlay: { ...preferences.overlay, duration: Number(event.target.value) } })} /><em>{(preferences.overlay.duration / 1000).toFixed(1)} sec</em></div></div>
      </fieldset>
    </div>
    <div className="settings-foot"><span><Check size={14} /> Preferences save automatically on this device.</span><button className="settings-done" onClick={onClose}>Done</button></div></section></div>;
}

export default App;
