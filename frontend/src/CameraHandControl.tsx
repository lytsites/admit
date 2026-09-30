import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, CameraOff } from 'lucide-react';
import { FilesetResolver, GestureRecognizer, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { GESTURE_CONFIG } from './gestureConfig';
import { OneEuroFilter } from './oneEuroFilter';

export type HandControlPoint = {
  id: string;
  /** Filtered palm center, mirrored to match the camera preview. */
  x: number;
  y: number;
  /** Filtered palm position for tracking and object drag. */
  palmX: number;
  palmY: number;
  /** Position to use at the instant a grab starts (preserves the pointer's hit target). */
  grabX: number;
  grabY: number;
  grabbing: boolean;
  justGrabbed: boolean;
  justReleased: boolean;
  pointing: boolean;
  victory: boolean;
  swipe: 'left' | 'right' | null;
  action: string;
};

export type HandControlFrame = {
  mode: 'one-hand' | 'blocked' | 'two-hand-scale';
  hands: HandControlPoint[];
};

type Position = { x: number; y: number };
type GestureState = {
  grabbing: boolean;
  fistSince: number | null;
  fistLastSeenAt: number | null;
  uncertainFistSince: number | null;
  lastHintAt: number;
  openSince: number | null;
  victorySince: number | null;
  swipeStart: Position | null;
  swipeArmed: boolean;
  lastSwipeAt: number;
  lastSwipeAtHint: number;
  cursorX: OneEuroFilter;
  cursorY: OneEuroFilter;
  palmX: OneEuroFilter;
  palmY: OneEuroFilter;
  displayedCursor: Position | null;
  lastPoint: HandControlPoint | null;
};

const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y);
const palmCenter = (landmarks: NormalizedLandmark[]): Position => ({
  x: 1 - [0, 5, 9, 13, 17].reduce((sum, index) => sum + landmarks[index].x, 0) / 5,
  y: [0, 5, 9, 13, 17].reduce((sum, index) => sum + landmarks[index].y, 0) / 5,
});
const makeGestureState = (): GestureState => ({
  grabbing: false, fistSince: null, fistLastSeenAt: null, uncertainFistSince: null, lastHintAt: 0, openSince: null,
  victorySince: null, swipeStart: null, swipeArmed: true, lastSwipeAt: 0, lastSwipeAtHint: 0,
  cursorX: new OneEuroFilter({ frequency: GESTURE_CONFIG.oneEuro.frequency, minCutoff: GESTURE_CONFIG.oneEuro.minCutoff, beta: GESTURE_CONFIG.oneEuro.beta, dCutoff: GESTURE_CONFIG.oneEuro.dCutoff, derivativeScale: GESTURE_CONFIG.oneEuro.derivativeScale }),
  cursorY: new OneEuroFilter({ frequency: GESTURE_CONFIG.oneEuro.frequency, minCutoff: GESTURE_CONFIG.oneEuro.minCutoff, beta: GESTURE_CONFIG.oneEuro.beta, dCutoff: GESTURE_CONFIG.oneEuro.dCutoff, derivativeScale: GESTURE_CONFIG.oneEuro.derivativeScale }),
  palmX: new OneEuroFilter({ frequency: GESTURE_CONFIG.oneEuro.frequency, minCutoff: GESTURE_CONFIG.oneEuro.dragMinCutoff, beta: GESTURE_CONFIG.oneEuro.dragBeta, dCutoff: GESTURE_CONFIG.oneEuro.dCutoff, derivativeScale: GESTURE_CONFIG.oneEuro.derivativeScale }),
  palmY: new OneEuroFilter({ frequency: GESTURE_CONFIG.oneEuro.frequency, minCutoff: GESTURE_CONFIG.oneEuro.dragMinCutoff, beta: GESTURE_CONFIG.oneEuro.dragBeta, dCutoff: GESTURE_CONFIG.oneEuro.dCutoff, derivativeScale: GESTURE_CONFIG.oneEuro.derivativeScale }),
  displayedCursor: null, lastPoint: null,
});

export default function CameraHandControl({ onFrame, disabled = false, onRaiseHand, onAction, active: controlledActive, onActiveChange, victoryScrollEnabled = false }: { onFrame: (frame: HandControlFrame | null) => void; disabled?: boolean; onRaiseHand?: () => void; onAction?: (message: string) => void; active?: boolean; onActiveChange?: (active: boolean) => void; victoryScrollEnabled?: boolean }) {
  const [internalActive, setInternalActive] = useState(false);
  const active = controlledActive ?? internalActive;
  const [status, setStatus] = useState('Камера выключена');
  const [error, setError] = useState('');
  const [cameraAspectRatio, setCameraAspectRatio] = useState('4 / 3');
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameHandler = useRef(onFrame); frameHandler.current = onFrame;
  const raiseHandler = useRef(onRaiseHand); raiseHandler.current = onRaiseHand;
  const actionHandler = useRef(onAction); actionHandler.current = onAction;
  const victoryScrollHandler = useRef(victoryScrollEnabled); victoryScrollHandler.current = victoryScrollEnabled;

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let animationFrame = 0;
    let stream: MediaStream | null = null;
    let recognizer: GestureRecognizer | null = null;
    let poseLandmarker: PoseLandmarker | null = null;
    let previousVideoTime = -1;
    let lastInferenceAt = 0;
    let lossHintAt = 0;
    let raiseSince: number | null = null;
    let raised = false;
    let lastRaiseAt = 0;
    let lastPoseHintAt = 0;
    let activePoseHint = '';
    let poseHintKey = '';
    let twoHandCandidateSince: number | null = null;
    let twoHandMode = false;
    let twoHandLostSince: number | null = null;
    let exitBlockedUntil = 0;
    let lastScaleHands: HandControlPoint[] = [];
    let activePalm: Position | null = null;
    let activeLastSeenAt = 0;
    let lastActivePoint: HandControlPoint | null = null;
    const gesture = makeGestureState();

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Браузер не поддерживает доступ к камере. Откройте сайт через localhost или HTTPS.');
        setError(''); setStatus('Запрашиваем камеру…');
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: GESTURE_CONFIG.mediaPipe.cameraWidth, max: GESTURE_CONFIG.mediaPipe.cameraMaxWidth }, height: { ideal: GESTURE_CONFIG.mediaPipe.cameraHeight, max: GESTURE_CONFIG.mediaPipe.cameraMaxHeight }, frameRate: { ideal: GESTURE_CONFIG.mediaPipe.cameraFrameRate, max: GESTURE_CONFIG.mediaPipe.cameraFrameRate } } });
        if (disposed) { stream.getTracks().forEach(track => track.stop()); return; }
        const video = videoRef.current;
        if (!video) throw new Error('Не удалось открыть предпросмотр камеры.');
        video.srcObject = stream;
        await video.play();
        setStatus('Загружаем распознавание руки…');
        const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
        recognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: { modelAssetPath: '/models/gesture_recognizer.task' },
          runningMode: 'VIDEO', numHands: GESTURE_CONFIG.mediaPipe.maxHands,
          minHandDetectionConfidence: GESTURE_CONFIG.mediaPipe.handDetectionConfidence,
          minHandPresenceConfidence: GESTURE_CONFIG.mediaPipe.handPresenceConfidence,
          minTrackingConfidence: GESTURE_CONFIG.mediaPipe.handTrackingConfidence,
          cannedGesturesClassifierOptions: { scoreThreshold: GESTURE_CONFIG.mediaPipe.gestureScoreThreshold, categoryAllowlist: ['Pointing_Up', 'Closed_Fist', 'Open_Palm', 'Victory'] },
        });
        if (raiseHandler.current) poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task' }, runningMode: 'VIDEO', numPoses: 1,
          minPoseDetectionConfidence: GESTURE_CONFIG.mediaPipe.poseDetectionConfidence, minPosePresenceConfidence: GESTURE_CONFIG.mediaPipe.posePresenceConfidence, minTrackingConfidence: GESTURE_CONFIG.mediaPipe.poseTrackingConfidence,
        });
        if (disposed) { recognizer.close(); stream.getTracks().forEach(track => track.stop()); return; }
        setStatus('Покажите руку в камеру');

        const buildPoint = (landmarks: NormalizedLandmark[], categories: { categoryName: string; score: number }[], now: number): HandControlPoint => {
          activePoseHint = '';
          const rawPalm = palmCenter(landmarks);
          const rawCursor = rawPalm;
          const filteredCursor = { x: gesture.cursorX.filter(rawCursor.x, now), y: gesture.cursorY.filter(rawCursor.y, now) };
          const filteredPalm = { x: gesture.palmX.filter(rawPalm.x, now), y: gesture.palmY.filter(rawPalm.y, now) };
          gesture.displayedCursor ??= filteredCursor;
          if (distance(filteredCursor, gesture.displayedCursor) >= GESTURE_CONFIG.cursorDeadZone) gesture.displayedCursor = filteredCursor;

          const score = (name: string) => categories.find(item => item.categoryName === name)?.score ?? 0;
          const closedFist = score('Closed_Fist');
          const openPalm = score('Open_Palm');
          const victoryScore = score('Victory');
          const pointingScore = score('Pointing_Up');
          const fingerExtension = (tip: number, pip: number, mcp: number) => distance(landmarks[tip], landmarks[mcp]) / Math.max(GESTURE_CONFIG.landmarkDistanceEpsilon, distance(landmarks[pip], landmarks[mcp]));
          const extendedFingerCount = [[8, 6, 5], [12, 10, 9], [16, 14, 13], [20, 18, 17]].filter(([tip, pip, mcp]) => fingerExtension(tip, pip, mcp) > GESTURE_CONFIG.fingerExtensionRatio).length;
          const openPalmDetected = openPalm >= GESTURE_CONFIG.confidence.Open_Palm || extendedFingerCount >= GESTURE_CONFIG.openPalmExtendedFingers;
          const victoryDetected = victoryScore >= GESTURE_CONFIG.confidence.Victory;
          const pointingPose = pointingScore >= GESTURE_CONFIG.confidence.Pointing_Up;
          const fistDetected = !pointingPose && !victoryDetected && !openPalmDetected && closedFist >= GESTURE_CONFIG.confidence.Closed_Fist;
          let poseHint: { key: string; message: string } | null = null;
          if (!gesture.grabbing && closedFist >= GESTURE_CONFIG.uncertainFistMinConfidence && closedFist < GESTURE_CONFIG.confidence.Closed_Fist && closedFist >= pointingScore && closedFist >= victoryScore) {
            poseHint = { key: 'fist', message: 'Кулак распознан не полностью: сомкните пальцы плотнее и держите большой палец снаружи.' };
          } else if (gesture.grabbing && !openPalmDetected && (openPalm >= 0.35 || extendedFingerCount >= 2)) {
            poseHint = { key: 'release', message: 'Чтобы отпустить объект, раскройте ладонь полностью и выпрямите пальцы.' };
          } else if (!gesture.grabbing && !pointingPose && pointingScore >= 0.38 && pointingScore >= victoryScore && pointingScore >= closedFist) {
            poseHint = { key: 'point', message: 'Для указателя: вытяните указательный палец, остальные пальцы согните.' };
          } else if (victoryScrollHandler.current && !gesture.grabbing && !victoryDetected && victoryScore >= 0.38 && victoryScore >= pointingScore && victoryScore >= closedFist) {
            poseHint = { key: 'victory', message: 'Для прокрутки: поднимите указательный и средний пальцы, остальные согните.' };
          } else if (!gesture.grabbing && !pointingPose && !victoryDetected && !openPalmDetected && !fistDetected) {
            poseHint = { key: 'unrecognized', message: 'Поза не распознана: вытяните указательный палец для курсора или сомкните пальцы в кулак для захвата.' };
          }
          if (poseHint) {
            if (poseHintKey !== poseHint.key) { poseHintKey = poseHint.key; gesture.uncertainFistSince = now; }
            if (gesture.uncertainFistSince !== null && now - gesture.uncertainFistSince >= GESTURE_CONFIG.uncertainFistHoldMs) {
              activePoseHint = poseHint.message;
              if (now - gesture.lastHintAt >= GESTURE_CONFIG.errorHintCooldownMs) {
                gesture.lastHintAt = now;
                actionHandler.current?.(poseHint.message);
              }
            }
          } else {
            gesture.uncertainFistSince = null;
            poseHintKey = '';
          }

          const wasGrabbing = gesture.grabbing;
          if (!gesture.grabbing) {
            if (fistDetected) {
              gesture.fistSince ??= now;
              gesture.fistLastSeenAt = now;
            } else if (pointingPose || victoryDetected || openPalmDetected) {
              gesture.fistSince = null; gesture.fistLastSeenAt = null;
            } else if (gesture.fistLastSeenAt !== null && now - gesture.fistLastSeenAt > GESTURE_CONFIG.grabRecognitionGraceMs) {
              gesture.fistSince = null; gesture.fistLastSeenAt = null;
            }
            if (gesture.fistSince !== null && now - gesture.fistSince >= GESTURE_CONFIG.grabHoldMs) {
              gesture.grabbing = true; gesture.fistSince = null; gesture.fistLastSeenAt = null; gesture.openSince = null;
            }
          } else {
            gesture.openSince = openPalmDetected ? gesture.openSince ?? now : null;
            if (gesture.openSince !== null && now - gesture.openSince >= GESTURE_CONFIG.releaseHoldMs) { gesture.grabbing = false; gesture.fistSince = null; gesture.fistLastSeenAt = null; }
          }

          gesture.victorySince = victoryDetected && !gesture.grabbing ? gesture.victorySince ?? now : null;
          const victory = !gesture.grabbing && victoryDetected && gesture.victorySince !== null && now - gesture.victorySince >= GESTURE_CONFIG.victoryActivationMs;
          if (victory && gesture.swipeArmed && !gesture.swipeStart) gesture.swipeStart = rawPalm;
          let swipe: 'left' | 'right' | null = null;
          if (!victory) {
            if (gesture.swipeStart) {
              const dx = rawPalm.x - gesture.swipeStart.x; const dy = rawPalm.y - gesture.swipeStart.y;
              if (Math.max(Math.abs(dx), Math.abs(dy)) > GESTURE_CONFIG.swipeHintMinMovement && now - gesture.lastSwipeAtHint >= GESTURE_CONFIG.errorHintCooldownMs) {
                const horizontalHint = Math.abs(dx) < GESTURE_CONFIG.swipeMinDistance ? 'Проведите рукой дальше влево или вправо' : Math.abs(dx) <= Math.abs(dy) * GESTURE_CONFIG.swipeHorizontalRatio ? 'Двигайте рукой горизонтально для перелистывания' : '';
                const verticalHint = Math.abs(dy) < GESTURE_CONFIG.swipeMinDistance ? 'Поднимите или опустите ладонь дальше' : Math.abs(dy) <= Math.abs(dx) * GESTURE_CONFIG.swipeHorizontalRatio ? 'Двигайте ладонью строго вверх или вниз' : '';
                const hint = victoryScrollHandler.current ? verticalHint : horizontalHint;
                if (hint) actionHandler.current?.(hint);
                gesture.lastSwipeAtHint = now;
              }
            }
            gesture.swipeStart = null; gesture.swipeArmed = true;
          } else if (gesture.swipeArmed && gesture.swipeStart && now - gesture.lastSwipeAt >= GESTURE_CONFIG.swipeCooldownMs) {
            const dx = rawPalm.x - gesture.swipeStart.x; const dy = rawPalm.y - gesture.swipeStart.y;
            if (Math.abs(dx) >= GESTURE_CONFIG.swipeMinDistance && Math.abs(dx) > Math.abs(dy) * GESTURE_CONFIG.swipeHorizontalRatio) {
              swipe = dx > 0 ? 'right' : 'left'; gesture.lastSwipeAt = now; gesture.swipeStart = null; gesture.swipeArmed = false;
            } else if (now - (gesture.victorySince ?? now) >= GESTURE_CONFIG.victorySwipeHintDelayMs && now - gesture.lastSwipeAtHint >= GESTURE_CONFIG.errorHintCooldownMs) {
              const horizontalHint = Math.abs(dx) < GESTURE_CONFIG.swipeMinDistance ? 'Проведите рукой дальше влево или вправо' : Math.abs(dx) <= Math.abs(dy) * GESTURE_CONFIG.swipeHorizontalRatio ? 'Двигайте рукой горизонтально для перелистывания' : '';
              const verticalHint = Math.abs(dy) < GESTURE_CONFIG.swipeMinDistance ? 'Поднимите или опустите ладонь дальше' : Math.abs(dy) <= Math.abs(dx) * GESTURE_CONFIG.swipeHorizontalRatio ? 'Двигайте ладонью строго вверх или вниз' : '';
              const hint = victoryScrollHandler.current ? verticalHint : horizontalHint;
              if (hint) actionHandler.current?.(hint);
              gesture.lastSwipeAtHint = now;
            }
          }
          const point: HandControlPoint = {
            id: 'active', x: gesture.displayedCursor.x, y: gesture.displayedCursor.y,
            palmX: filteredPalm.x, palmY: filteredPalm.y,
            grabX: wasGrabbing ? gesture.displayedCursor.x : gesture.lastPoint?.x ?? gesture.displayedCursor.x,
            grabY: wasGrabbing ? gesture.displayedCursor.y : gesture.lastPoint?.y ?? gesture.displayedCursor.y,
            grabbing: gesture.grabbing, justGrabbed: gesture.grabbing && !wasGrabbing, justReleased: !gesture.grabbing && wasGrabbing,
            pointing: !gesture.grabbing && !victory && pointingPose, victory, swipe,
            action: gesture.grabbing ? '✊ Захват' : victory ? (victoryScrollHandler.current ? '✌ Прокрутка' : '✌ Перелистывание') : pointingPose ? '☝ Указатель' : openPalmDetected ? '🖐 Отпустить' : '',
          };
          gesture.lastPoint = point;
          return point;
        };

        const buildScalePoints = (items: { landmarks: NormalizedLandmark[]; center: Position }[]): HandControlPoint[] => items.map((item, index) => ({
          id: `scale-${index + 1}`, x: item.center.x, y: item.center.y, palmX: item.center.x, palmY: item.center.y,
          grabX: item.center.x, grabY: item.center.y, grabbing: false, justGrabbed: false, justReleased: false,
          pointing: false, victory: false, swipe: null, action: '↔ Масштабирование',
        }));

        const detect = () => {
          if (disposed || !videoRef.current || !recognizer) return;
          const video = videoRef.current;
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== previousVideoTime) {
            try {
              const now = performance.now();
              if (now - lastInferenceAt < GESTURE_CONFIG.inferenceIntervalMs) {
                animationFrame = requestAnimationFrame(detect);
                return;
              }
              previousVideoTime = video.currentTime;
              lastInferenceAt = now;
              const result = recognizer.recognizeForVideo(video, now);
              const pose = poseLandmarker?.detectForVideo(video, now).landmarks[0];
              if (pose) {
                const head = Math.min(pose[0]?.y ?? 1, pose[7]?.y ?? 1, pose[8]?.y ?? 1, pose[9]?.y ?? 1, pose[10]?.y ?? 1);
                const raisedLeft = (pose[15]?.y ?? 1) < head - GESTURE_CONFIG.raiseHandHeadMargin && (pose[13]?.y ?? 1) < (pose[11]?.y ?? 1) - GESTURE_CONFIG.raiseHandArmLiftMargin;
                const raisedRight = (pose[16]?.y ?? 1) < head - GESTURE_CONFIG.raiseHandHeadMargin && (pose[14]?.y ?? 1) < (pose[12]?.y ?? 1) - GESTURE_CONFIG.raiseHandArmLiftMargin;
                if (raisedLeft || raisedRight) {
                  raiseSince ??= now;
                  if (!raised && now - raiseSince >= GESTURE_CONFIG.raiseHandHoldMs && now - lastRaiseAt >= GESTURE_CONFIG.raiseHandCooldownMs) {
                    raised = true; lastRaiseAt = now; raiseHandler.current?.(); actionHandler.current?.('🙋 Рука поднята');
                  }
                } else {
                  raiseSince = null; raised = false;
                  const nearLeft = (pose[15]?.y ?? 1) < (pose[11]?.y ?? 1) && (pose[15]?.y ?? 1) > head - GESTURE_CONFIG.raiseHandNearHeadMargin;
                  const nearRight = (pose[16]?.y ?? 1) < (pose[12]?.y ?? 1) && (pose[16]?.y ?? 1) > head - GESTURE_CONFIG.raiseHandNearHeadMargin;
                  if ((nearLeft || nearRight) && now - lastPoseHintAt >= GESTURE_CONFIG.errorHintCooldownMs) { lastPoseHintAt = now; actionHandler.current?.('Почти: поднимите кисть выше головы, чтобы поднять руку.'); }
                }
              } else { raiseSince = null; }

              const observations = result.landmarks.slice(0, 2).map((landmarks, index) => ({ landmarks, categories: result.gestures[index] ?? [], center: palmCenter(landmarks) }));

              if (twoHandMode) {
                if (observations.length >= 2) {
                  twoHandLostSince = null;
                  lastScaleHands = buildScalePoints(observations.slice(0, 2));
                  frameHandler.current({ mode: 'two-hand-scale', hands: lastScaleHands });
                  setStatus('↔ Масштабирование двумя руками · разведите/сведите ладони');
                } else {
                  twoHandLostSince ??= now;
                  if (now - twoHandLostSince <= GESTURE_CONFIG.twoHandLostGraceMs) {
                    frameHandler.current({ mode: 'two-hand-scale', hands: lastScaleHands });
                    setStatus('↔ Масштабирование · покажите вторую руку');
                  } else {
                    twoHandMode = false;
                    twoHandCandidateSince = null;
                    twoHandLostSince = null;
                    exitBlockedUntil = now + GESTURE_CONFIG.twoHandExitDelayMs;
                    gesture.fistSince = null; gesture.fistLastSeenAt = null; gesture.openSince = null; gesture.victorySince = null; gesture.swipeStart = null;
                    frameHandler.current({ mode: 'blocked', hands: [] });
                    setStatus('Режим масштабирования завершён');
                  }
                }
              } else if (observations.length >= 2) {
                twoHandCandidateSince ??= now;
                if (now - twoHandCandidateSince >= GESTURE_CONFIG.twoHandActivationMs) {
                  twoHandMode = true; twoHandLostSince = null;
                  lastScaleHands = buildScalePoints(observations.slice(0, 2));
                  gesture.fistSince = null; gesture.fistLastSeenAt = null; gesture.openSince = null; gesture.victorySince = null; gesture.swipeStart = null;
                  frameHandler.current({ mode: 'two-hand-scale', hands: lastScaleHands });
                  setStatus('↔ Масштабирование двумя руками · разведите/сведите ладони');
                } else {
                  frameHandler.current({ mode: 'blocked', hands: [] });
                  setStatus('Обнаружены две руки · подготовка масштабирования…');
                }
              } else {
                twoHandCandidateSince = null;
                if (now < exitBlockedUntil) {
                  frameHandler.current({ mode: 'blocked', hands: [] });
                  setStatus('Возвращаем управление одной рукой…');
                } else if (observations.length === 1) {
                  const candidate = observations[0];
                  const gap = now - activeLastSeenAt;
                  if (activePalm && gap <= GESTURE_CONFIG.handLostGraceMs && distance(candidate.center, activePalm) > GESTURE_CONFIG.maxHandTrackDistance) {
                    frameHandler.current({ mode: 'blocked', hands: [] });
                    if (now - lossHintAt >= GESTURE_CONFIG.errorHintCooldownMs) { lossHintAt = now; actionHandler.current?.('Верните руку в область камеры'); }
                    setStatus('Ожидаем возвращения активной руки…');
                  } else if (gap > GESTURE_CONFIG.handLostGraceMs && gesture.grabbing && lastActivePoint) {
                    const releasePoint = { ...lastActivePoint, grabbing: false, justGrabbed: false, justReleased: true, action: '🖐 Отпустить' };
                    gesture.grabbing = false; gesture.fistSince = null; gesture.fistLastSeenAt = null; gesture.openSince = null; gesture.victorySince = null;
                    gesture.cursorX.reset(); gesture.cursorY.reset(); gesture.palmX.reset(); gesture.palmY.reset(); gesture.displayedCursor = null;
                    activePalm = candidate.center; activeLastSeenAt = now; lastActivePoint = releasePoint;
                    frameHandler.current({ mode: 'one-hand', hands: [releasePoint] });
                    setStatus('☝ Указатель · ✊ захват · 🖐 отпустить · ✌ свайп');
                  } else {
                    if (!activePalm || gap > GESTURE_CONFIG.handLostGraceMs) {
                      gesture.fistSince = null; gesture.fistLastSeenAt = null; gesture.openSince = null; gesture.victorySince = null; gesture.swipeStart = null;
                      if (gap > GESTURE_CONFIG.handLostGraceMs) { gesture.grabbing = false; gesture.cursorX.reset(); gesture.cursorY.reset(); gesture.palmX.reset(); gesture.palmY.reset(); gesture.displayedCursor = null; }
                    }
                    const point = buildPoint(candidate.landmarks, candidate.categories, now);
                    activePalm = candidate.center; activeLastSeenAt = now; lastActivePoint = point;
                    frameHandler.current({ mode: 'one-hand', hands: [point] });
                    setStatus(activePoseHint || (point.grabbing ? '✊ Захват · перемещайте ладонь' : point.victory ? victoryScrollHandler.current ? '✌ Двигайте рукой вверх или вниз для прокрутки' : '✌ Проведите рукой влево или вправо для листания' : '☝ указатель · ✊ захват · 🖐 отпустить'));
                  }
                } else if (activePalm && now - activeLastSeenAt <= GESTURE_CONFIG.handLostGraceMs) {
                  frameHandler.current({ mode: 'blocked', hands: [] });
                  if (now - lossHintAt >= GESTURE_CONFIG.errorHintCooldownMs) { lossHintAt = now; actionHandler.current?.('Верните руку в область камеры'); }
                  setStatus('Рука временно потеряна · ждем её возвращения…');
                } else {
                  const releasePoint = gesture.grabbing && lastActivePoint ? { ...lastActivePoint, grabbing: false, justGrabbed: false, justReleased: true, action: '🖐 Отпустить' } : null;
                  gesture.grabbing = false; gesture.fistSince = null; gesture.fistLastSeenAt = null; gesture.openSince = null; gesture.victorySince = null;
                  activePalm = null; activeLastSeenAt = 0; lastActivePoint = null;
                  frameHandler.current({ mode: releasePoint ? 'one-hand' : 'blocked', hands: releasePoint ? [releasePoint] : [] });
                  setStatus('Верните руку в область камеры');
                }
              }
            } catch (cause) {
              console.error('Ошибка распознавания руки:', cause);
              setError('Не удалось распознать руку. Попробуйте выключить и включить камеру.');
              if (onActiveChange) onActiveChange(false); else setInternalActive(false);
            }
          }
          animationFrame = requestAnimationFrame(detect);
        };
        animationFrame = requestAnimationFrame(detect);
      } catch (cause) {
        if (!disposed) {
          const message = cause instanceof Error ? cause.message : 'Не удалось запустить управление камерой.';
          setError(message); setStatus('Камера недоступна');
          if (onActiveChange) onActiveChange(false); else setInternalActive(false);
        }
      }
    };
    void start();
    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      frameHandler.current(null);
      recognizer?.close(); poseLandmarker?.close();
      stream?.getTracks().forEach(track => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [active]);

  return <>
    <button data-camera-action="toggle-camera" className={`camera-control-button ${active ? 'is-active' : ''}`} onClick={() => { setError(''); const next = !active; if (onActiveChange) onActiveChange(next); else setInternalActive(next); }} disabled={disabled} title={active ? 'Выключить управление камерой' : 'Управление доской рукой'}>
      {active ? <CameraOff size={16} /> : <Camera size={16} />}{active ? 'Камера' : 'Управление камерой'}
    </button>
    {active && createPortal(<div className="camera-hand-panel is-visible" style={{ aspectRatio: cameraAspectRatio }} aria-live="polite">
      <video ref={videoRef} className="camera-hand-video" muted playsInline aria-label="Локальный предпросмотр камеры" onLoadedMetadata={event => {
        const { videoWidth, videoHeight } = event.currentTarget;
        if (videoWidth > 0 && videoHeight > 0) setCameraAspectRatio(`${videoWidth} / ${videoHeight}`);
      }} />
      <div className="camera-hand-caption"><span className="camera-live-dot" />{error || status}<small>Изображение камеры видите только вы</small></div>
    </div>, document.body)}
  </>;
}
