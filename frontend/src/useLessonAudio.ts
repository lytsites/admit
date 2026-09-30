import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from './Dashboard';

type AudioSignal = RTCSessionDescriptionInit | RTCIceCandidateInit;
type ServerMessage = {
  type?: string;
  userId?: string;
  fromUserId?: string;
  toUserId?: string;
  signal?: AudioSignal;
  detail?: string;
};

export function useLessonAudio(user: User, sendMessage: (message: Record<string, unknown>) => void) {
  const peers = useRef(new Map<string, RTCPeerConnection>());
  const peerTasks = useRef(new Map<string, Promise<RTCPeerConnection>>());
  const teacherSenders = useRef(new Map<string, RTCRtpSender>());
  const pendingCandidates = useRef(new Map<string, RTCIceCandidateInit[]>());
  const allowedUsers = useRef(new Set<string>());
  const localMicrophone = useRef<MediaStream | null>(null);
  const studentPeerTask = useRef<Promise<RTCPeerConnection> | null>(null);
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [teacherMicEnabled, setTeacherMicEnabled] = useState(false);
  const [studentMicStatus, setStudentMicStatus] = useState<'idle' | 'requesting' | 'active' | 'error'>('idle');
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [audioError, setAudioError] = useState('');

  const sendSignal = useCallback((targetUserId: string, signal: AudioSignal) => {
    sendMessage({ type: 'audio_signal', targetUserId, signal });
  }, [sendMessage]);

  const closePeer = useCallback((userId: string) => {
    const peer = peers.current.get(userId);
    if (peer) {
      peer.ontrack = null;
      peer.onicecandidate = null;
      peer.close();
      peers.current.delete(userId);
    }
    teacherSenders.current.delete(userId);
    pendingCandidates.current.delete(userId);
    setRemoteStreams(current => {
      if (!(userId in current)) return current;
      const next = { ...current };
      delete next[userId];
      return next;
    });
  }, []);

  const createPeer = useCallback((peerUserId: string) => {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const audioTransceiver = peer.addTransceiver('audio', { direction: 'sendrecv' });
    peers.current.set(peerUserId, peer);
    if (user.role === 'teacher') {
      teacherSenders.current.set(peerUserId, audioTransceiver.sender);
      const micTrack = localMicrophone.current?.getAudioTracks()[0];
      if (micTrack) void audioTransceiver.sender.replaceTrack(micTrack).catch(() => undefined);
    } else {
      const micTrack = localMicrophone.current?.getAudioTracks()[0];
      if (micTrack) void audioTransceiver.sender.replaceTrack(micTrack).catch(() => undefined);
    }
    peer.onicecandidate = event => {
      if (event.candidate) sendSignal(peerUserId, event.candidate.toJSON());
    };
    peer.ontrack = event => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      setRemoteStreams(current => ({ ...current, [peerUserId]: stream }));
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') setAudioError('Не удалось установить голосовую связь. Проверьте подключение к интернету.');
    };
    return peer;
  }, [sendSignal, user.role]);

  const ensureStudentPeer = useCallback(async () => {
    const teacherId = 'teacher';
    const currentPeer = peers.current.get(teacherId);
    if (currentPeer) return currentPeer;
    if (studentPeerTask.current) return studentPeerTask.current;
    const task = (async () => {
      setStudentMicStatus('requesting');
      setAudioError('');
      try {
        if (!localMicrophone.current) {
          if (!navigator.mediaDevices?.getUserMedia) throw new Error('Откройте сайт по HTTPS и разрешите доступ к микрофону.');
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          });
          if (!allowedUsers.current.has(user.id)) {
            stream.getTracks().forEach(track => track.stop());
            setStudentMicStatus('idle');
            throw new Error('Преподаватель отозвал разрешение говорить.');
          }
          localMicrophone.current = stream;
        }
        const track = localMicrophone.current.getAudioTracks()[0];
        if (!track) throw new Error('Браузер не передал аудиодорожку микрофона.');
        track.enabled = true;
        const peer = createPeer(teacherId);
        setStudentMicStatus('active');
        return peer;
      } catch (error) {
        localMicrophone.current?.getTracks().forEach(track => track.stop());
        localMicrophone.current = null;
        const detail = error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Разрешите доступ к микрофону в браузере, чтобы ответить.'
          : error instanceof Error ? error.message : 'Не удалось включить микрофон.';
        setStudentMicStatus('error');
        setAudioError(detail);
        sendMessage({ type: 'audio_error', targetUserId: 'teacher', detail });
        throw error;
      }
    })();
    studentPeerTask.current = task;
    try { return await task; }
    finally { if (studentPeerTask.current === task) studentPeerTask.current = null; }
  }, [createPeer, sendMessage, user.id]);

  const startTeacherPeer = useCallback(async (studentId: string) => {
    if (user.role !== 'teacher') return;
    const currentPeer = peers.current.get(studentId);
    if (currentPeer) {
      if (currentPeer.signalingState === 'stable') {
        const offer = await currentPeer.createOffer();
        await currentPeer.setLocalDescription(offer);
        if (currentPeer.localDescription) sendSignal(studentId, currentPeer.localDescription.toJSON());
      }
      return;
    }
    const existingTask = peerTasks.current.get(studentId);
    if (existingTask) return existingTask;
    const task = (async () => {
      const peer = createPeer(studentId);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.localDescription) sendSignal(studentId, peer.localDescription.toJSON());
      return peer;
    })();
    peerTasks.current.set(studentId, task);
    try { await task; }
    catch (error) {
      closePeer(studentId);
      setAudioError(error instanceof Error ? error.message : 'Не удалось начать голосовую связь.');
    } finally { if (peerTasks.current.get(studentId) === task) peerTasks.current.delete(studentId); }
  }, [closePeer, createPeer, sendSignal, user.role]);

  const flushCandidates = useCallback(async (peerUserId: string, peer: RTCPeerConnection) => {
    const queued = pendingCandidates.current.get(peerUserId) ?? [];
    pendingCandidates.current.delete(peerUserId);
    for (const candidate of queued) await peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
  }, []);

  const handleMessage = useCallback(async (message: ServerMessage) => {
    if (message.type === 'audio_allowed' && message.userId) {
      allowedUsers.current.add(message.userId);
      setPermissions(current => ({ ...current, [message.userId!]: true }));
      if (user.role === 'teacher') setAudioError('');
      if (user.role === 'teacher') await startTeacherPeer(message.userId);
      else if (message.userId === user.id) void ensureStudentPeer().catch(() => undefined);
      return;
    }
    if (message.type === 'audio_revoked' && message.userId) {
      allowedUsers.current.delete(message.userId);
      setPermissions(current => ({ ...current, [message.userId!]: false }));
      closePeer(user.role === 'teacher' ? message.userId : 'teacher');
      if (user.role === 'student' && message.userId === user.id) {
        localMicrophone.current?.getTracks().forEach(track => track.stop());
        localMicrophone.current = null;
        studentPeerTask.current = null;
        setStudentMicStatus('idle');
        setAudioError('');
      }
      return;
    }
    if (message.type === 'audio_error' && user.role === 'teacher' && message.toUserId === user.id) {
      setAudioError(message.detail ?? 'Ученик не смог включить микрофон.');
      return;
    }
    if (message.type !== 'audio_signal' || message.toUserId !== user.id || !message.fromUserId || !message.signal) return;
    const peerUserId = user.role === 'teacher' ? message.fromUserId : 'teacher';
    const signal = message.signal;
    if ('type' in signal && signal.type === 'offer' && user.role === 'student') {
      const peer = await ensureStudentPeer();
      await peer.setRemoteDescription(new RTCSessionDescription(signal));
      await flushCandidates(peerUserId, peer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (peer.localDescription) sendSignal(peerUserId, peer.localDescription.toJSON());
      return;
    }
    const peer = peers.current.get(peerUserId);
    if (!peer) return;
    if ('type' in signal && signal.type === 'answer' && user.role === 'teacher') {
      await peer.setRemoteDescription(new RTCSessionDescription(signal));
      await flushCandidates(peerUserId, peer);
    } else if ('candidate' in signal && signal.candidate) {
      if (peer.remoteDescription) await peer.addIceCandidate(new RTCIceCandidate(signal)).catch(() => undefined);
      else pendingCandidates.current.set(peerUserId, [...(pendingCandidates.current.get(peerUserId) ?? []), signal]);
    }
  }, [closePeer, ensureStudentPeer, flushCandidates, sendSignal, startTeacherPeer, user.id, user.role]);

  const toggleTeacherMic = useCallback(async () => {
    if (user.role !== 'teacher') return;
    const currentTrack = localMicrophone.current?.getAudioTracks()[0];
    if (currentTrack) {
      currentTrack.enabled = !currentTrack.enabled;
      setTeacherMicEnabled(currentTrack.enabled);
      return;
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Откройте сайт по HTTPS и разрешите доступ к микрофону.');
      localMicrophone.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const track = localMicrophone.current.getAudioTracks()[0];
      if (!track) throw new Error('Браузер не передал аудиодорожку микрофона.');
      for (const sender of teacherSenders.current.values()) await sender.replaceTrack(track).catch(() => undefined);
      setTeacherMicEnabled(true);
      setAudioError('');
    } catch (error) {
      localMicrophone.current?.getTracks().forEach(track => track.stop());
      localMicrophone.current = null;
      setTeacherMicEnabled(false);
      setAudioError(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Разрешите доступ к микрофону в настройках браузера.'
        : error instanceof Error ? error.message : 'Не удалось включить микрофон.');
    }
  }, [user.role]);

  const allowStudent = useCallback((studentId: string) => sendMessage({ type: 'audio_allow', userId: studentId }), [sendMessage]);
  const retryStudentMic = useCallback(async () => { try { await ensureStudentPeer(); } catch { /* the hook keeps the permission error for the student */ } }, [ensureStudentPeer]);

  useEffect(() => () => {
    peers.current.forEach(peer => peer.close());
    peers.current.clear();
    teacherSenders.current.clear();
    pendingCandidates.current.clear();
    localMicrophone.current?.getTracks().forEach(track => track.stop());
    localMicrophone.current = null;
  }, []);

  return { permissions, teacherMicEnabled, studentMicStatus, remoteStreams, audioError, setAudioError, handleMessage, toggleTeacherMic, allowStudent, retryStudentMic };
}
