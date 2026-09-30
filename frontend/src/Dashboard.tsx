import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import { Bell, BookOpen, CalendarDays, Camera, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CircleHelp, CircleStop, Clock3, Copy, GraduationCap, History, LogOut, Maximize2, Menu, Minimize2, MousePointer2, Pencil, Plus, Settings, Trash2, UsersRound, UserRound, Image, FileVideo2, X } from 'lucide-react';
import CameraHandControl, { type HandControlFrame } from './CameraHandControl';
import { GESTURE_CONFIG } from './gestureConfig';
import { OneEuroFilter } from './oneEuroFilter';
import './dashboard.css';

const API_URL = new URL(import.meta.env.VITE_API_URL ?? '/api', window.location.origin).toString().replace(/\/$/, '');
export type User = { id: string; name: string; email: string; role: 'teacher' | 'student' };
type Classroom = { id: string; name: string; studentCount: number; inviteCode?: string | null };
type Lesson = { id: string; title: string; startsAt: string; startedAt: string | null; endedAt?: string | null; status: 'scheduled' | 'live' | 'ended'; lessonType: 'scheduled' | 'ad_hoc'; classId: string; className: string; scheduleRuleId?: string | null; occurrenceDate?: string | null };
type ScheduleRule = { id: string; classId: string; className: string; title: string; dayOfWeek: number; startTime: string; excludedDates?: string[] };
type Asset = { id: string; filename: string; contentType: string; createdAt: string };
type Participant = { userId: string; name: string; role: 'teacher' | 'student'; connected: number };
type BoardObject = { id: string; label: string; kind: 'note' | 'image' | 'video'; x: number; y: number; scale?: number; color?: string; assetId?: string };
type CameraScaleState = { objectId: string | null; startDistance: number; startScale: number; filter: OneEuroFilter; lastAppliedDistance: number; lastSentAt: number };
type CameraObjectDrag = { id: string; offsetX: number; offsetY: number; width: number; height: number };
type Page = 'lesson' | 'profile' | 'classes' | 'class' | 'schedule' | 'history' | 'storage' | 'settings';

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${localStorage.getItem('motionclass_token') ?? ''}`, ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail ?? 'Не удалось выполнить запрос.');
  return data as T;
}

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return `${words[0][0]}${words[1][0]}`.toLocaleUpperCase('ru');
  return [...(words[0] ?? '?')].slice(0, 2).join('').toLocaleUpperCase('ru');
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(value));
}
function formatTime(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export default function Dashboard({ user: initialUser, onLogout, onUserChange }: { user: User; onLogout: () => void; onUserChange: (user: User) => void }) {
  const [user, setUser] = useState(initialUser);
  const [classes, setClasses] = useState<Classroom[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [scheduleRules, setScheduleRules] = useState<ScheduleRule[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [page, setPage] = useState<Page>('lesson');
  const [selectedClass, setSelectedClass] = useState<Classroom | null>(null);
  const [openLesson, setOpenLesson] = useState<Lesson | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('motionclass_sidebar_collapsed') === 'true');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [endingLesson, setEndingLesson] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [profile, classList, lessonList, ruleList] = await Promise.all([
        api<{ user: User }>('/auth/me'),
        api<Classroom[]>('/classes'), api<Lesson[]>('/lessons'), api<ScheduleRule[]>('/schedule-rules'),
      ]);
      setUser(profile.user); onUserChange(profile.user);
      setClasses(classList); setLessons(lessonList); setScheduleRules(ruleList); setLoadError('');
    } catch (error) { setLoadError((error as Error).message); }
  }, [onUserChange]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => void refresh(), 15000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => {
    let connectionId = sessionStorage.getItem('motionclass_site_connection');
    if (!connectionId) { connectionId = crypto.randomUUID(); sessionStorage.setItem('motionclass_site_connection', connectionId); }
    const heartbeat = () => { void api('/presence/heartbeat', { method: 'POST', body: JSON.stringify({ connectionId }) }).catch(() => undefined); };
    heartbeat();
    const timer = window.setInterval(heartbeat, 12000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { localStorage.setItem('motionclass_sidebar_collapsed', String(collapsed)); }, [collapsed]);
  useEffect(() => {
    if (user.role === 'teacher' && (page === 'storage' || page === 'lesson')) api<Asset[]>('/storage').then(setAssets).catch(error => setLoadError(error.message));
  }, [page, user.role]);

  const scheduledLessons = useMemo(() => lessons.filter(item => item.lessonType === 'scheduled' && item.status !== 'ended'), [lessons]);
  const upcoming = useMemo(() => scheduledLessons.filter(item => item.status === 'scheduled' && new Date(item.startsAt).getTime() > Date.now()).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 6), [scheduledLessons]);
  const historyLessons = useMemo(() => lessons.filter(item => item.status === 'ended').sort((a, b) => (b.endedAt ?? b.startsAt).localeCompare(a.endedAt ?? a.startsAt)), [lessons]);
  const live = useMemo(() => lessons.filter(item => item.status === 'live').sort((a, b) => b.startsAt.localeCompare(a.startsAt)), [lessons]);
  const navItems = user.role === 'teacher'
    ? [{ id: 'lesson' as Page, label: 'Урок', icon: BookOpen }, { id: 'profile' as Page, label: 'Профиль', icon: UserRound }, { id: 'classes' as Page, label: 'Классы', icon: UsersRound }, { id: 'schedule' as Page, label: 'Расписание', icon: CalendarDays }, { id: 'history' as Page, label: 'История уроков', icon: History }, { id: 'storage' as Page, label: 'Хранилище', icon: Image }]
    : [{ id: 'lesson' as Page, label: 'Урок', icon: BookOpen }, { id: 'profile' as Page, label: 'Профиль', icon: UserRound }, { id: 'class' as Page, label: 'Мой класс', icon: UsersRound }, { id: 'schedule' as Page, label: 'Расписание', icon: CalendarDays }, { id: 'history' as Page, label: 'История уроков', icon: History }];

  function flash(message: string) { setToast(message); window.setTimeout(() => setToast(''), 2600); }
  function open(pageId: Page) { setPage(pageId); setAccountOpen(false); setNotificationsOpen(false); setMobileMenuOpen(false); }
  async function beginNow() {
    if (user.role !== 'teacher') return;
    const chosen = classes[0];
    if (!chosen) { flash('Сначала создайте класс'); open('classes'); return; }
    setSaving(true);
    try {
      const lesson = await api<Lesson>('/lessons', { method: 'POST', body: JSON.stringify({ classId: chosen.id, title: 'Внеплановый урок', startsAt: new Date().toISOString(), startNow: true }) });
      await refresh(); setOpenLesson(lesson); open('lesson');
    } catch (error) { flash((error as Error).message); }
    finally { setSaving(false); }
  }

  async function joinLesson(lesson: Lesson) {
    if (user.role === 'teacher' && !lesson.startedAt) {
      try { await api(`/lessons/${lesson.id}/start`, { method: 'POST' }); }
      catch (error) { flash((error as Error).message); return; }
    }
    const key = `motionclass-connection-${lesson.id}`;
    const connectionId = sessionStorage.getItem(key) ?? crypto.randomUUID();
    sessionStorage.setItem(key, connectionId);
    try { await api(`/lessons/${lesson.id}/presence/join`, { method: 'POST', body: JSON.stringify({ connectionId }) }); }
    catch (error) { flash((error as Error).message); return; }
    setOpenLesson({ ...lesson, startedAt: lesson.startedAt ?? new Date().toISOString(), status: 'live' }); open('lesson');
  }

  async function finishLesson(lesson: Lesson): Promise<boolean> {
    setEndingLesson(true);
    try { await api(`/lessons/${lesson.id}/end`, { method: 'POST' }); if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined); setOpenLesson(null); await refresh(); flash('Урок завершён. Доска сохранена.'); return true; }
    catch (error) { flash((error as Error).message); return false; }
    finally { setEndingLesson(false); }
  }

  async function saveScheduleRule(rule: ScheduleRule | null, payload: { classId: string; dayOfWeek: number; startTime: string }): Promise<ScheduleRule | null> {
    try {
      const saved = await api<ScheduleRule>(rule ? `/schedule-rules/${rule.id}` : '/schedule-rules', { method: rule ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      setScheduleRules(current => rule ? current.map(item => item.id === saved.id ? saved : item) : [...current, saved]);
      void api<Lesson[]>('/lessons').then(setLessons).catch(() => undefined);
      flash(rule ? 'Расписание обновлено' : 'Урок добавлен в расписание');
      return saved;
    } catch (error) { flash((error as Error).message); return null; }
  }

  async function removeScheduleOccurrence(rule: ScheduleRule, date: string) {
    if (!window.confirm(`Удалить урок «${rule.className}» ${date} в ${rule.startTime}? Остальные занятия по расписанию сохранятся.`)) return;
    try {
      await api(`/schedule-rules/${rule.id}/occurrences/${date}`, { method: 'DELETE' });
      setScheduleRules(current => current.map(item => item.id === rule.id ? { ...item, excludedDates: [...new Set([...(item.excludedDates ?? []), date])] } : item));
      void api<Lesson[]>('/lessons').then(setLessons).catch(() => undefined);
      flash('Урок на выбранный день удалён');
    } catch (error) { flash((error as Error).message); }
  }

  async function addClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target);
    try { const created = await api<Classroom>('/classes', { method: 'POST', body: JSON.stringify({ name: form.get('className') }) }); setSelectedClass(created); await refresh(); target.reset(); flash('Класс создан. Ссылка для регистрации учеников готова.'); }
    catch (error) { flash((error as Error).message); }
  }

  async function deleteClass(classroom: Classroom) {
    const confirmed = window.confirm(`Удалить класс «${classroom.name}»? Все связанные уроки и история будут удалены. Аккаунты учеников сохранятся, но они покинут этот класс.`);
    if (!confirmed) return;
    try {
      await api(`/classes/${classroom.id}`, { method: 'DELETE' });
      setSelectedClass(current => current?.id === classroom.id ? null : current);
      await refresh();
      flash('Класс удалён');
    } catch (error) { flash((error as Error).message); }
  }

  async function joinClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    try {
      const joined = await api<{ id: string; name: string }>('/classes/join', { method: 'POST', body: JSON.stringify({ inviteCode: form.get('inviteCode') }) });
      setSelectedClass({ ...joined, studentCount: 0 });
      await refresh();
      target.reset();
      flash('Вы присоединились к классу');
    } catch (error) { flash((error as Error).message); }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { const result = await api<{ user: User }>('/auth/me', { method: 'PATCH', body: JSON.stringify({ name: form.get('name') }) }); setUser(result.user); onUserChange(result.user); flash('Профиль обновлён'); }
    catch (error) { flash((error as Error).message); }
  }

  async function upload(file?: File) {
    if (!file) return;
    const form = new FormData(); form.append('file', file);
    try { await api('/storage', { method: 'POST', body: form }); const items = await api<Asset[]>('/storage'); setAssets(items); flash('Файл загружен в хранилище'); }
    catch (error) { flash((error as Error).message); }
  }

  const activeClass = selectedClass ?? classes[0] ?? null;
  const displayLesson = openLesson ?? (user.role === 'teacher' ? live[0] ?? null : null);

  return <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${mobileMenuOpen ? 'mobile-menu-open' : ''} ${page === 'lesson' && displayLesson ? 'active-lesson-mode' : ''}`}>
    <aside className="app-sidebar">
      <div className="sidebar-brand"><span className="brand-mark"><GraduationCap size={24} /></span><span className="brand-word">Motion<span>Class</span></span></div>
      <div className="nav-caption">ОБУЧЕНИЕ</div>
      <nav className="side-navigation">{navItems.map(item => <button key={item.id} className={`nav-link ${page === item.id || (item.id === 'classes' && page === 'class') ? 'active' : ''}`} onClick={() => open(item.id)} title={collapsed ? item.label : undefined}><item.icon size={19} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-bottom"><button className={`nav-link ${page === 'settings' ? 'active' : ''}`} onClick={() => open('settings')} title={collapsed ? 'Настройки' : undefined}><Settings size={19} /><span>Настройки</span></button><button className="nav-link help-link" onClick={() => flash('Помощь появится в следующих обновлениях')} title={collapsed ? 'Помощь' : undefined}><CircleHelp size={19} /><span>Помощь</span></button><button className="collapse-button" onClick={() => setCollapsed(!collapsed)}><ChevronsLeft size={18} /><span>Свернуть меню</span></button></div>
    </aside>
    <div className="app-main">
      <header className="topbar"><button className="mobile-menu" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Меню"><Menu size={20} /></button><div className="breadcrumbs"><span>Кабинет</span><ChevronRight size={15} /><strong>{pageTitle(page)}</strong></div><div className="top-actions">
        <div className="top-popover-wrap"><button className={`top-icon-button ${notificationsOpen ? 'selected' : ''}`} onClick={() => { setNotificationsOpen(!notificationsOpen); setAccountOpen(false); }} aria-label="Уведомления"><Bell size={19} />{upcoming.length > 0 && <i />}</button>{notificationsOpen && <div className="popover notification-popover"><div className="popover-heading"><strong>Уведомления</strong><span>{upcoming.length}</span></div>{upcoming.length ? upcoming.map(item => <button key={item.id} className="notification-item" onClick={() => void joinLesson(item)}><span className="notification-dot" /><span><b>{item.title}</b><small>{item.className} · {formatDate(item.startsAt)}, {formatTime(item.startsAt)}</small></span></button>) : <p className="popover-empty">Новых уведомлений нет</p>}</div>}</div>
        <div className="top-popover-wrap"><button className={`account-chip ${accountOpen ? 'selected' : ''}`} onClick={() => { setAccountOpen(!accountOpen); setNotificationsOpen(false); }}><span className="avatar">{initials(user.name)}</span><span className="account-name">{user.name}</span><ChevronRight className="account-chevron" size={15} /></button>{accountOpen && <div className="popover account-popover"><div className="account-summary"><span className="avatar large">{initials(user.name)}</span><span><b>{user.name}</b><small>{user.email}</small></span></div><button onClick={() => open('profile')}><UserRound size={17} />Профиль</button><button onClick={onLogout} className="logout-action"><LogOut size={17} />Выйти из аккаунта</button></div>}</div>
      </div></header>
      <main className="workspace">
        {loadError && <div className="inline-error">{loadError}<button onClick={() => void refresh()}>Повторить</button></div>}
        {page === 'lesson' && <LessonPage user={user} lesson={displayLesson} activeLesson={user.role === 'student' ? live[0] ?? null : null} lessons={upcoming} classes={classes} onStart={beginNow} onJoin={joinLesson} onEnd={finishLesson} endingLesson={endingLesson} saving={saving} assets={assets} onOpenStorage={() => open('storage')} onParticipantConnected={name => flash(`Подключился ${name}`)} onStudentLessonEnded={() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); setLessons(current => current.map(item => item.id === displayLesson?.id ? { ...item, status: 'ended', endedAt: new Date().toISOString() } : item)); setOpenLesson(null); void refresh(); flash('Преподаватель завершил урок'); }} />}
        {page === 'profile' && <ProfilePage user={user} onSettings={() => open('settings')} />}
        {page === 'settings' && <SettingsPage user={user} onSave={saveProfile} />}
        {(page === 'classes' || page === 'class') && <ClassesPage user={user} classes={classes} selectedClass={activeClass} onChoose={setSelectedClass} onCreate={addClass} onDelete={deleteClass} onJoinClass={joinClass} />}
        {page === 'schedule' && <SchedulePage user={user} classes={classes} rules={scheduleRules} lessons={lessons} onSaveRule={saveScheduleRule} onDeleteOccurrence={removeScheduleOccurrence} onJoin={joinLesson} />}
        {page === 'history' && <HistoryPage lessons={historyLessons} userRole={user.role} />}
        {page === 'storage' && <StoragePage assets={assets} inputRef={fileInput} onUpload={upload} />}
      </main>
    </div>
    {toast && <div className="toast-message"><Check size={16} />{toast}</div>}
  </div>;
}

function pageTitle(page: Page) { return ({ lesson: 'Урок', profile: 'Профиль', classes: 'Классы', class: 'Мой класс', schedule: 'Расписание', history: 'История уроков', storage: 'Хранилище', settings: 'Настройки' })[page]; }

function LessonPage({ user, lesson, activeLesson, lessons, classes, onStart, onJoin, onEnd, endingLesson, saving, assets, onOpenStorage, onParticipantConnected, onStudentLessonEnded }: { user: User; lesson: Lesson | null; activeLesson: Lesson | null; lessons: Lesson[]; classes: Classroom[]; onStart: () => void; onJoin: (lesson: Lesson) => void; onEnd: (lesson: Lesson) => Promise<boolean>; endingLesson: boolean; saving: boolean; assets: Asset[]; onOpenStorage: () => void; onParticipantConnected: (name: string) => void; onStudentLessonEnded: () => void }) {
  const [endConfirmationOpen, setEndConfirmationOpen] = useState(false);
  useEffect(() => {
    if (!endConfirmationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !endingLesson) setEndConfirmationOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [endConfirmationOpen, endingLesson]);
  const confirmEndLesson = async () => {
    if (!lesson || endingLesson) return;
    if (await onEnd(lesson)) setEndConfirmationOpen(false);
  };
  return <div className="page-content lesson-page"><PageHeading eyebrow="ОБЩЕЕ ПРОСТРАНСТВО" title="Интерактивный урок" description="Общая доска для преподавателя и учеников." />
    {lesson ? <div className="lesson-meta-card"><div className="lesson-meta-icon"><BookOpen size={22} /></div><div><strong>{lesson.title}</strong><span>{lesson.className} · {formatDate(lesson.startsAt)} в {formatTime(lesson.startsAt)}</span></div><span className="live-pill"><i />Идёт урок</span>{user.role === 'teacher' && <button className="finish-lesson-button" onClick={() => setEndConfirmationOpen(true)}><CircleStop size={15} />Завершить урок</button>}</div> : activeLesson ? <div className="lesson-meta-card"><div className="lesson-meta-icon"><BookOpen size={22} /></div><div><strong>{activeLesson.title}</strong><span>{activeLesson.className} · начался {formatTime(activeLesson.startedAt ?? activeLesson.startsAt)}</span></div><span className="live-pill"><i />Идёт урок</span><button className="primary-button compact" onClick={() => onJoin(activeLesson)}><ChevronRight size={16} />Подключиться</button></div> : <div className="empty-lesson-card"><div className="empty-board-illustration"><div className="board-sparkle sparkle-one">✦</div><div className="board-window"><div className="board-window-top"><i /><i /><i /></div><div className="board-canvas"><span className="canvas-card card-one" /><span className="canvas-card card-two" /><span className="canvas-pencil" /></div></div><span className="empty-ring" /></div><h2>Сейчас уроков нет</h2><p>Доска уже готова. Начните внеплановый урок или выберите занятие в расписании.</p>{user.role === 'teacher' ? <button className="primary-button compact" onClick={onStart} disabled={saving}><Plus size={18} />{saving ? 'Создаём…' : 'Начать внеплановый урок'}</button> : <span className="muted-hint">Когда преподаватель начнёт урок, здесь появится кнопка подключения.</span>}</div>}
    {lesson && <Board lesson={lesson} user={user} assets={assets} onOpenStorage={onOpenStorage} onRequestEnd={() => setEndConfirmationOpen(true)} endConfirmationOpen={endConfirmationOpen} onCancelEnd={() => { if (!endingLesson) setEndConfirmationOpen(false); }} onConfirmEnd={() => void confirmEndLesson()} endingLesson={endingLesson} onParticipantConnected={onParticipantConnected} onStudentLessonEnded={onStudentLessonEnded} />}
    {!lesson && <div className="upcoming-section"><div className="section-heading"><div><h3>Ближайшие занятия</h3><p>Только будущие уроки по расписанию</p></div><CalendarDays size={19} /></div>{lessons.length ? lessons.slice(0, 3).map(item => <div className="upcoming-row" key={item.id}><div className="date-tile"><b>{new Date(item.startsAt).getDate()}</b><span>{new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(new Date(item.startsAt))}</span></div><div className="upcoming-info"><b>{item.title}</b><span>{item.className} · {formatDate(item.startsAt)} · {formatTime(item.startsAt)}</span></div><span className="upcoming-state"><Clock3 size={14} />Запланирован</span></div>) : <p className="empty-list">Ближайших уроков по расписанию нет.</p>}</div>}
    <div className="lesson-class-count"><UsersRound size={17} /><span>{classes.length ? `У вас ${classes.length} ${classes.length === 1 ? 'класс' : 'класса'}` : 'Классов пока нет'}</span></div>
  </div>;
}

function Board({ lesson, user, assets, onOpenStorage, onRequestEnd, endConfirmationOpen, onCancelEnd, onConfirmEnd, endingLesson, onParticipantConnected, onStudentLessonEnded }: { lesson: Lesson; user: User; assets: Asset[]; onOpenStorage: () => void; onRequestEnd: () => void; endConfirmationOpen: boolean; onCancelEnd: () => void; onConfirmEnd: () => void; endingLesson: boolean; onParticipantConnected: (name: string) => void; onStudentLessonEnded: () => void }) {
  const [objects, setObjects] = useState<BoardObject[]>([]);
  const [controlMode, setControlMode] = useState<'mouse' | 'camera'>('mouse');
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [pageTransition, setPageTransition] = useState<'next' | 'previous' | null>(null);
  const pageNumberRef = useRef(1);
  const pageWasInitialized = useRef(false);
  const pageNavigationPending = useRef(false);
  const [loading, setLoading] = useState(true);
  const [storageModalOpen, setStorageModalOpen] = useState(false);
  const storageModalScroll = useRef<HTMLDivElement>(null);
  const modalScrollLastY = useRef<number | null>(null);
  const handCursorLayer = useRef<HTMLDivElement>(null);
  const handCursorElements = useRef(new Map<string, HTMLSpanElement>());
  const cameraActionHover = useRef<HTMLElement | null>(null);
  const dragging = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const cameraHandDrags = useRef(new Map<string, CameraObjectDrag>());
  const cameraScale = useRef<CameraScaleState | null>(null);
  const cameraMode = useRef<HandControlFrame['mode']>('one-hand');
  const lastHoveredObjectId = useRef<string | null>(null);
  const cameraLastSentAt = useRef(new Map<string, number>());
  const boardControlRef = useRef<HTMLElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [raisedStudents, setRaisedStudents] = useState<Record<string, string>>({});
  const [handAction, setHandAction] = useState('');
  const lastHandAction = useRef('');
  const handFeedbackUntil = useRef(0);
  const studentRaised = useRef(false);
  const pendingRaiseHand = useRef(false);
  const raiseSound = useRef<AudioContext | null>(null);
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'reconnecting' | 'ended'>('connecting');
  const [boardSyncState, setBoardSyncState] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const latestObjects = useRef(objects); latestObjects.current = objects;
  useEffect(() => {
    if (!storageModalOpen) { modalScrollLastY.current = null; return; }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setStorageModalOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [storageModalOpen]);
  const savingBoard = useRef(0);
  const boardRevision = useRef(0);
  const dragSocket = useRef<WebSocket | null>(null);
  const lastDragSentAt = useRef(0);
  const participantConnectedHandler = useRef(onParticipantConnected); participantConnectedHandler.current = onParticipantConnected;
  const studentLessonEndedHandler = useRef(onStudentLessonEnded); studentLessonEndedHandler.current = onStudentLessonEnded;
  const lessonEndedNotified = useRef(false);
  function notifyStudentLessonEnded() { if (lessonEndedNotified.current) return; lessonEndedNotified.current = true; studentLessonEndedHandler.current(); }
  function selectBoardPage(nextPage: number) {
    if (pageWasInitialized.current && nextPage !== pageNumberRef.current) setPageTransition(nextPage > pageNumberRef.current ? 'next' : 'previous');
    pageWasInitialized.current = true;
    pageNumberRef.current = nextPage;
    setPageNumber(nextPage);
  }
  function renderHandCursors(hands: HandControlFrame['hands']) {
    const layer = handCursorLayer.current;
    if (!layer) return;
    const visibleIds = new Set<string>();
    for (const hand of hands) {
      visibleIds.add(hand.id);
      let cursor = handCursorElements.current.get(hand.id);
      if (!cursor) {
        cursor = document.createElement('span');
        cursor.setAttribute('aria-hidden', 'true');
        handCursorElements.current.set(hand.id, cursor);
      }
      if (cursor.parentElement !== layer) layer.append(cursor);
      const className = `board-hand-cursor ${hand.grabbing ? 'is-grabbing' : ''} ${hand.pointing ? 'is-pointing' : ''} ${hand.victory ? 'is-victory' : ''}`;
      if (cursor.className !== className) cursor.className = className;
      cursor.style.left = `${Math.min(100, Math.max(0, hand.x * 100))}%`;
      cursor.style.top = `${Math.min(100, Math.max(0, hand.y * 100))}%`;
    }
    for (const [id, cursor] of handCursorElements.current) {
      if (visibleIds.has(id)) continue;
      cursor.remove();
      handCursorElements.current.delete(id);
    }
  }
  const pendingOperations = useRef(new Map<string, ({ operation: 'upsert'; object: BoardObject } | { operation: 'delete'; objectId: string }) & { pageNumber: number }>());
  const retryPendingRef = useRef<() => void>(() => undefined);
  function mergePending(serverObjects: BoardObject[]) {
    const merged = new Map(serverObjects.map(item => [item.id, item]));
    const activeIds = new Set([...cameraHandDrags.current.values()].map(drag => drag.id));
    if (cameraScale.current?.objectId) activeIds.add(cameraScale.current.objectId);
    if (dragging.current) activeIds.add(dragging.current.id);
    for (const activelyDraggedId of activeIds) {
      const localObject = latestObjects.current.find(item => item.id === activelyDraggedId);
      if (localObject) merged.set(activelyDraggedId, localObject);
    }
    for (const operation of pendingOperations.current.values()) {
      if (operation.pageNumber !== pageNumberRef.current) continue;
      if (operation.operation === 'upsert') merged.set(operation.object.id, operation.object);
      else merged.delete(operation.objectId);
    }
    return [...merged.values()];
  }
  const refreshBoard = useCallback(async () => {
    try {
      if (dragging.current || cameraHandDrags.current.size || cameraScale.current || savingBoard.current) return;
      const data = await api<{ objects: BoardObject[]; revision: number; pageNumber: number; pageCount: number }>(`/lessons/${lesson.id}/board`);
      if (data.revision < boardRevision.current) return;
      boardRevision.current = data.revision;
      selectBoardPage(data.pageNumber); setPageCount(data.pageCount);
      const merged = mergePending(data.objects); latestObjects.current = merged; setObjects(merged);
    }
    catch { /* next poll retries */ }
    finally { setLoading(false); }
  }, [lesson.id]);
  useEffect(() => { void refreshBoard(); const timer = window.setInterval(() => void refreshBoard(), 1800); return () => window.clearInterval(timer); }, [refreshBoard]);
  useEffect(() => {
    let disposed = false;
    let retryTimer = 0;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (disposed) return;
      setBoardSyncState('connecting');
      socket = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/lessons/${lesson.id}/board/connect`);
      socket.onopen = () => { dragSocket.current = socket; socket?.send(JSON.stringify({ token: localStorage.getItem('motionclass_token') ?? '' })); };
      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data) as { type?: string; revision?: number; objects?: BoardObject[]; pageNumber?: number; pageCount?: number; userId?: string; name?: string };
          if (message.type === 'ready') { setBoardSyncState(pendingOperations.current.size ? 'reconnecting' : 'connected'); void refreshBoard(); retryPendingRef.current(); if (pendingRaiseHand.current && user.role === 'student') { socket?.send(JSON.stringify({ type: 'raise_hand' })); pendingRaiseHand.current = false; } }
          if (message.type === 'participant_connected' && message.userId !== user.id && message.name) participantConnectedHandler.current(message.name);
          if (message.type === 'raise_hand' && message.userId && message.name) {
            setRaisedStudents(current => ({ ...current, [message.userId!]: message.name! }));
            if (user.role === 'teacher') {
              try {
                const context = raiseSound.current ?? new AudioContext(); raiseSound.current = context;
                void context.resume();
                const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.frequency.value = 880; gain.gain.value = 0.06;
                oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.12);
              } catch { /* audio may be disabled by the browser */ }
            }
          }
          if (message.type === 'raise_hand_reset' && message.userId) { setRaisedStudents(current => { const next = { ...current }; delete next[message.userId!]; return next; }); if (message.userId === user.id) { studentRaised.current = false; pendingRaiseHand.current = false; } }
          if (message.type === 'lesson_ended') {
            setConnectionState('ended');
            if (user.role === 'student') notifyStudentLessonEnded();
          }
          if (message.type === 'board_updated') {
            if (typeof message.revision === 'number' && Array.isArray(message.objects) && message.revision >= boardRevision.current) {
              boardRevision.current = message.revision;
              if (typeof message.pageNumber === 'number') selectBoardPage(message.pageNumber);
              if (typeof message.pageCount === 'number') setPageCount(message.pageCount);
              const merged = mergePending(message.objects); latestObjects.current = merged; setObjects(merged);
            } else void refreshBoard();
          }
        } catch { /* ignore malformed sync messages */ }
      };
      socket.onclose = () => { if (dragSocket.current === socket) dragSocket.current = null; if (!disposed) { setBoardSyncState('reconnecting'); retryTimer = window.setTimeout(connect, 1200); } };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => { disposed = true; window.clearTimeout(retryTimer); if (dragSocket.current === socket) dragSocket.current = null; socket?.close(); };
  }, [lesson.id, refreshBoard, user.id, user.role]);
  useEffect(() => {
    const sessionKey = `motionclass-connection-${lesson.id}`;
    const connectionId = sessionStorage.getItem(sessionKey) ?? crypto.randomUUID();
    sessionStorage.setItem(sessionKey, connectionId);
    let disposed = false;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('motionclass_token') ?? ''}` };
    const join = async () => {
      try { await fetch(`${API_URL}/lessons/${lesson.id}/presence/join`, { method: 'POST', headers, body: JSON.stringify({ connectionId }) }); if (!disposed) setConnectionState('connected'); }
      catch { if (!disposed) setConnectionState('reconnecting'); }
    };
    const heartbeat = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const response = await fetch(`${API_URL}/lessons/${lesson.id}/presence/heartbeat`, { method: 'PUT', headers, body: JSON.stringify({ connectionId }) });
        if (response.status === 409) {
          const problem = await response.json().catch(() => ({})) as { detail?: string };
          if (problem.detail === 'Урок больше не активен.') {
            if (!disposed) { setConnectionState('ended'); if (user.role === 'student') notifyStudentLessonEnded(); }
          } else if (!disposed) {
            // A lost presence session is recoverable; it does not mean the lesson ended.
            setConnectionState('reconnecting');
            await join();
          }
          return;
        }
        if (!response.ok) throw new Error('heartbeat failed');
        if (!disposed) setConnectionState('connected');
      } catch { if (!disposed) { setConnectionState('reconnecting'); await join(); } }
    };
    const refreshPeople = async () => {
      try { const response = await fetch(`${API_URL}/lessons/${lesson.id}/participants`, { headers }); if (response.ok && !disposed) setParticipants(await response.json()); } catch { /* retry on the next interval */ }
    };
    const leave = () => { void fetch(`${API_URL}/lessons/${lesson.id}/presence/leave`, { method: 'POST', headers, body: JSON.stringify({ connectionId }), keepalive: true }); };
    void join(); void refreshPeople();
    const timer = window.setInterval(() => { void heartbeat(); void refreshPeople(); }, 12000);
    const visible = () => { if (document.visibilityState === 'visible') { void heartbeat(); void refreshPeople(); } };
    window.addEventListener('pagehide', leave); document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', visible); leave(); };
  }, [lesson.id]);
  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* the immersive board layout still fills the app viewport */ }
  }
  useEffect(() => {
    let cancelled = false;
    const previewIds = new Set(objects.flatMap(object => object.assetId ? [object.assetId] : []));
    if (storageModalOpen) for (const asset of assets) previewIds.add(asset.id);
    for (const assetId of previewIds) {
      if (mediaUrls[assetId]) continue;
      fetch(`${API_URL}/storage/${assetId}/file`, { headers: { Authorization: `Bearer ${localStorage.getItem('motionclass_token') ?? ''}` } }).then(response => response.blob()).then(blob => { if (!cancelled) setMediaUrls(current => ({ ...current, [assetId]: URL.createObjectURL(blob) })); }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [objects, assets, storageModalOpen, mediaUrls]);
  const persistOperation = useCallback(async (operation: { operation: 'upsert'; object: BoardObject } | { operation: 'delete'; objectId: string }, targetPage = pageNumberRef.current) => {
    const id = operation.operation === 'upsert' ? operation.object.id : operation.objectId;
    const key = `${targetPage}:${id}`;
    const pageOperation = { ...operation, pageNumber: targetPage };
    pendingOperations.current.set(key, pageOperation);
    savingBoard.current += 1;
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await api<{ revision: number }>(`/lessons/${lesson.id}/board/objects`, { method: 'POST', body: JSON.stringify(pageOperation) });
          boardRevision.current = Math.max(boardRevision.current, response.revision);
          if (JSON.stringify(pendingOperations.current.get(key)) === JSON.stringify(pageOperation)) pendingOperations.current.delete(key);
          setBoardSyncState(pendingOperations.current.size ? 'reconnecting' : 'connected');
          return;
        } catch (error) { lastError = error; if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 180 * (attempt + 1))); }
      }
      console.error('Не удалось синхронизировать доску:', lastError);
      setBoardSyncState('reconnecting');
    } finally { savingBoard.current -= 1; }
  }, [lesson.id]);
  useEffect(() => { retryPendingRef.current = () => { for (const operation of pendingOperations.current.values()) void persistOperation(operation, operation.pageNumber); }; }, [persistOperation]);
  useEffect(() => { const timer = window.setInterval(() => retryPendingRef.current(), 4000); return () => window.clearInterval(timer); }, []);
  const save = useCallback(async (next: BoardObject[]) => {
    const targetPage = pageNumberRef.current;
    const previous = latestObjects.current;
    latestObjects.current = next; setObjects(next);
    const oldById = new Map(previous.map(item => [item.id, item]));
    const newById = new Map(next.map(item => [item.id, item]));
    const operations: ({ operation: 'upsert'; object: BoardObject } | { operation: 'delete'; objectId: string })[] = [];
    for (const item of next) if (JSON.stringify(oldById.get(item.id)) !== JSON.stringify(item)) operations.push({ operation: 'upsert', object: item });
    for (const item of previous) if (!newById.has(item.id)) operations.push({ operation: 'delete', objectId: item.id });
    if (!operations.length) return;
    for (const operation of operations) await persistOperation(operation, targetPage);
  }, [persistOperation]);
  async function navigatePage(direction: 'next' | 'previous') {
    if (connectionState === 'ended' || pageNavigationPending.current) return;
    pageNavigationPending.current = true;
    try {
      const data = await api<{ objects: BoardObject[]; revision: number; pageNumber: number; pageCount: number }>(`/lessons/${lesson.id}/board/pages/navigate`, { method: 'POST', body: JSON.stringify({ direction }) });
      if (data.revision < boardRevision.current) return;
      selectBoardPage(data.pageNumber); setPageCount(data.pageCount);
      boardRevision.current = data.revision;
      latestObjects.current = data.objects; setObjects(data.objects);
    } catch (error) {
      console.error('Не удалось переключить лист доски:', error);
    } finally { pageNavigationPending.current = false; }
  }
  function addNote() { void save([...latestObjects.current, { id: crypto.randomUUID(), label: 'Новая заметка', kind: 'note', x: 12 + Math.random() * 42, y: 12 + Math.random() * 45, color: ['yellow', 'blue', 'pink'][Math.floor(Math.random() * 3)] }]); }
  function addAssetToBoard(asset: Asset) {
    const object: BoardObject = { id: crypto.randomUUID(), assetId: asset.id, label: asset.filename, kind: asset.contentType.startsWith('video/') ? 'video' : 'image', x: 14 + Math.random() * 32, y: 14 + Math.random() * 35 };
    void save([...latestObjects.current, object]);
    setStorageModalOpen(false);
    setHandAction(`Добавлено: ${asset.filename}`);
    lastHandAction.current = `Добавлено: ${asset.filename}`;
    handFeedbackUntil.current = performance.now() + GESTURE_CONFIG.feedbackDurationMs;
  }
  function startDrag(event: PointerEvent<HTMLDivElement>, object: BoardObject) { const rect = boardRef.current?.getBoundingClientRect(); if (!rect) return; dragging.current = { id: object.id, dx: event.clientX - rect.left - rect.width * object.x / 100, dy: event.clientY - rect.top - rect.height * object.y / 100 }; event.currentTarget.setPointerCapture(event.pointerId); }
  function moveDrag(event: PointerEvent<HTMLDivElement>) { if (!dragging.current || !boardRef.current) return; const rect = boardRef.current.getBoundingClientRect(); const x = Math.min(88, Math.max(0, (event.clientX - rect.left - dragging.current.dx) / rect.width * 100)); const y = Math.min(78, Math.max(0, (event.clientY - rect.top - dragging.current.dy) / rect.height * 100)); const next = latestObjects.current.map(item => item.id === dragging.current?.id ? { ...item, x, y } : item); latestObjects.current = next; setObjects(next); const moved = next.find(item => item.id === dragging.current?.id); const now = performance.now(); if (moved && now - lastDragSentAt.current >= 55 && dragSocket.current?.readyState === WebSocket.OPEN) { dragSocket.current.send(JSON.stringify({ type: 'drag', object: moved, pageNumber: pageNumberRef.current })); lastDragSentAt.current = now; } }
  function endDrag() { if (!dragging.current) return; const objectId = dragging.current.id; dragging.current = null; const object = latestObjects.current.find(item => item.id === objectId); if (object) { if (dragSocket.current?.readyState === WebSocket.OPEN) dragSocket.current.send(JSON.stringify({ type: 'drag', object, pageNumber: pageNumberRef.current })); void persistOperation({ operation: 'upsert', object }); } }
  function handleHandFrame(frame: HandControlFrame | null) {
    const board = boardRef.current;
    const controlRoot = boardControlRef.current;
    if (!frame || !board || !controlRoot || connectionState === 'ended') {
      modalScrollLastY.current = null;
      renderHandCursors([]);
      setHandAction(''); lastHandAction.current = '';
      cameraActionHover.current?.classList.remove('camera-hover-target'); cameraActionHover.current = null;
      board?.querySelectorAll('.camera-controlled-object').forEach(element => element.classList.remove('camera-controlled-object'));
      const changedIds = new Set([...cameraHandDrags.current.values()].map(drag => drag.id));
      if (cameraScale.current?.objectId) changedIds.add(cameraScale.current.objectId);
      cameraHandDrags.current.clear(); cameraScale.current = null; cameraMode.current = 'blocked';
      if (connectionState !== 'ended') for (const id of changedIds) { const object = latestObjects.current.find(item => item.id === id); if (object) void persistOperation({ operation: 'upsert', object }); }
      if (changedIds.size) setObjects(latestObjects.current);
      return;
    }

    const rect = controlRoot.getBoundingClientRect();
    const boardRect = board.getBoundingClientRect();
    const now = performance.now();
    const applyHandObjectVisual = (object: BoardObject) => {
      const element = board.querySelector<HTMLElement>(`[data-board-object-id="${CSS.escape(object.id)}"]`);
      if (!element) return;
      element.classList.add('camera-controlled-object');
      element.style.left = `${object.x}%`; element.style.top = `${object.y}%`; element.style.transform = `scale(${object.scale ?? 1})`;
    };
    const finishObject = (id: string) => {
      board.querySelector<HTMLElement>(`[data-board-object-id="${CSS.escape(id)}"]`)?.classList.remove('camera-controlled-object');
      const object = latestObjects.current.find(item => item.id === id);
      if (object) {
        setObjects(latestObjects.current);
        if (dragSocket.current?.readyState === WebSocket.OPEN) dragSocket.current.send(JSON.stringify({ type: 'drag', object, pageNumber: pageNumberRef.current }));
        void persistOperation({ operation: 'upsert', object });
      }
    };
    const endScale = () => {
      const scale = cameraScale.current;
      cameraScale.current = null;
      if (scale?.objectId) finishObject(scale.objectId);
    };
    const setFeedback = (message: string) => {
      if (lastHandAction.current === message) return;
      lastHandAction.current = message; handFeedbackUntil.current = now + GESTURE_CONFIG.feedbackDurationMs; setHandAction(message);
    };

    // While the picker is open, camera input belongs to the modal only.
    // In particular, Victory's vertical movement must never move the board.
    if (storageModalOpen) {
      cameraHandDrags.current.clear();
      endScale();
      if (frame.mode !== 'one-hand' || !frame.hands[0]) {
        cameraActionHover.current?.classList.remove('camera-hover-target'); cameraActionHover.current = null;
        modalScrollLastY.current = null;
        renderHandCursors([]);
        return;
      }
      const hand = frame.hands[0];
      renderHandCursors([hand]);
      const hoverX = rect.left + hand.x * rect.width;
      const hoverY = rect.top + hand.y * rect.height;
      const actionAtPointer = document.elementFromPoint(hoverX, hoverY)?.closest<HTMLElement>('[data-camera-action]') ?? null;
      if (cameraActionHover.current !== actionAtPointer) {
        cameraActionHover.current?.classList.remove('camera-hover-target');
        cameraActionHover.current = actionAtPointer;
        cameraActionHover.current?.classList.add('camera-hover-target');
      }
      if (hand.victory) {
        if (modalScrollLastY.current !== null && storageModalScroll.current) {
          const delta = hand.palmY - modalScrollLastY.current;
          storageModalScroll.current.scrollTop += delta * storageModalScroll.current.clientHeight * GESTURE_CONFIG.storageModalScrollSensitivity;
        }
        modalScrollLastY.current = hand.palmY;
      } else modalScrollLastY.current = null;
      if (hand.justGrabbed) {
        const grabX = rect.left + hand.grabX * rect.width;
        const grabY = rect.top + hand.grabY * rect.height;
        const target = document.elementFromPoint(grabX, grabY)?.closest<HTMLButtonElement>('[data-camera-action]') ?? null;
        if (target && controlRoot.contains(target) && !target.disabled) {
          target.click();
          const label = target.getAttribute('aria-label') ?? target.textContent?.trim() ?? 'Действие';
          setFeedback(`Выбрано: ${label}`);
        }
      }
      return;
    }
    modalScrollLastY.current = null;

    if (frame.mode !== 'two-hand-scale' && cameraMode.current === 'two-hand-scale') endScale();
    cameraMode.current = frame.mode;
    if (frame.mode !== 'one-hand') {
      // Pending/active two-hand mode blocks every one-hand command and hides the cursor.
      renderHandCursors([]);
      cameraActionHover.current?.classList.remove('camera-hover-target'); cameraActionHover.current = null;
      if (frame.mode === 'blocked') return;

      if (!cameraScale.current) {
        const activeDrag = [...cameraHandDrags.current.values()][0];
        const targetId = activeDrag?.id ?? dragging.current?.id ?? lastHoveredObjectId.current;
        cameraHandDrags.current.clear();
        const target = targetId ? latestObjects.current.find(item => item.id === targetId) : null;
        const first = frame.hands[0]; const second = frame.hands[1];
        if (target && first && second) {
          const startDistance = Math.max(0.001, Math.hypot(first.palmX - second.palmX, first.palmY - second.palmY));
          const filter = new OneEuroFilter({ frequency: GESTURE_CONFIG.oneEuro.frequency, minCutoff: GESTURE_CONFIG.scaleDistanceMinCutoff, beta: GESTURE_CONFIG.oneEuro.beta, dCutoff: GESTURE_CONFIG.oneEuro.dCutoff, derivativeScale: GESTURE_CONFIG.oneEuro.derivativeScale });
          const filteredStart = filter.filter(startDistance, now);
          cameraScale.current = { objectId: target.id, startDistance: filteredStart, startScale: target.scale ?? 1, filter, lastAppliedDistance: filteredStart, lastSentAt: now };
          applyHandObjectVisual(target);
          setFeedback('↔ Масштабирование');
        } else {
          cameraScale.current = { objectId: null, startDistance: 0, startScale: 1, filter: new OneEuroFilter({ frequency: GESTURE_CONFIG.oneEuro.frequency, minCutoff: GESTURE_CONFIG.scaleDistanceMinCutoff, beta: GESTURE_CONFIG.oneEuro.beta, dCutoff: GESTURE_CONFIG.oneEuro.dCutoff, derivativeScale: GESTURE_CONFIG.oneEuro.derivativeScale }), lastAppliedDistance: 0, lastSentAt: now };
          setFeedback('↔ Сначала наведитесь на объект');
        }
      }

      const scale = cameraScale.current;
      if (scale?.objectId && frame.hands.length >= 2) {
        const [first, second] = frame.hands;
        const rawDistance = Math.max(0.001, Math.hypot(first.palmX - second.palmX, first.palmY - second.palmY));
        const filteredDistance = scale.filter.filter(rawDistance, now);
        if (Math.abs(filteredDistance - scale.lastAppliedDistance) / Math.max(scale.lastAppliedDistance, 0.001) >= GESTURE_CONFIG.scaleDeadZone) {
          const nextScale = Math.min(GESTURE_CONFIG.maxScale, Math.max(GESTURE_CONFIG.minScale, scale.startScale * filteredDistance / scale.startDistance));
          const next = latestObjects.current.map(item => item.id === scale.objectId ? { ...item, scale: nextScale } : item);
          latestObjects.current = next; scale.lastAppliedDistance = filteredDistance;
          const resized = next.find(item => item.id === scale.objectId);
          if (resized) {
            applyHandObjectVisual(resized);
            if (now - scale.lastSentAt >= GESTURE_CONFIG.boardUpdateIntervalMs && dragSocket.current?.readyState === WebSocket.OPEN) {
              dragSocket.current.send(JSON.stringify({ type: 'drag', object: resized, pageNumber: pageNumberRef.current }));
              scale.lastSentAt = now;
            }
          }
        }
      }
      return;
    }

    const swipeHand = frame.hands.find(hand => hand.swipe);
    if (swipeHand?.swipe && !storageModalOpen) {
      setFeedback(swipeHand.swipe === 'right' ? '➡ Следующий лист' : '⬅ Предыдущий лист');
      void navigatePage(swipeHand.swipe === 'right' ? 'next' : 'previous');
    } else {
      const activeHand = frame.hands[0];
      const action = activeHand?.grabbing && cameraHandDrags.current.has(activeHand.id) ? '✊ Перемещение' : activeHand?.action ?? '';
      if (now >= handFeedbackUntil.current && action !== lastHandAction.current) { lastHandAction.current = action; setHandAction(action); }
    }

    const nearestObject = (x: number, y: number) => {
      if (x < boardRect.left || x > boardRect.right || y < boardRect.top || y > boardRect.bottom) return null;
      const direct = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-board-object-id]');
      if (direct) return direct;
      return [...board.querySelectorAll<HTMLElement>('[data-board-object-id]')]
        .map(element => ({ element, bounds: element.getBoundingClientRect() }))
        .filter(item => x >= item.bounds.left - GESTURE_CONFIG.objectHitPaddingPx && x <= item.bounds.right + GESTURE_CONFIG.objectHitPaddingPx && y >= item.bounds.top - GESTURE_CONFIG.objectHitPaddingPx && y <= item.bounds.bottom + GESTURE_CONFIG.objectHitPaddingPx)
        .sort((a, b) => Math.hypot(x - a.bounds.left - a.bounds.width / 2, y - a.bounds.top - a.bounds.height / 2) - Math.hypot(x - b.bounds.left - b.bounds.width / 2, y - b.bounds.top - b.bounds.height / 2))[0]?.element ?? null;
    };
    const hand = frame.hands[0];
    if (!hand) { renderHandCursors([]); return; }
    const pointerX = rect.left + hand.x * rect.width;
    const pointerY = rect.top + hand.y * rect.height;
    const palmX = rect.left + hand.palmX * rect.width;
    const palmY = rect.top + hand.palmY * rect.height;
    const hovered = nearestObject(pointerX, pointerY);
    lastHoveredObjectId.current = hovered?.dataset.boardObjectId ?? null;
    const actionAtPointer = document.elementFromPoint(pointerX, pointerY)?.closest<HTMLElement>('[data-camera-action]') ?? null;
    if (cameraActionHover.current !== actionAtPointer) {
      cameraActionHover.current?.classList.remove('camera-hover-target');
      cameraActionHover.current = actionAtPointer;
      cameraActionHover.current?.classList.add('camera-hover-target');
    }

    if (hand.justGrabbed) {
      const grabX = rect.left + hand.grabX * rect.width;
      const grabY = rect.top + hand.grabY * rect.height;
      const actionTarget = document.elementFromPoint(grabX, grabY)?.closest<HTMLButtonElement>('[data-camera-action]') ?? null;
      if (actionTarget && controlRoot.contains(actionTarget)) {
        if (!actionTarget.disabled) {
          const label = actionTarget.getAttribute('aria-label') ?? actionTarget.textContent?.trim() ?? 'Действие';
          actionTarget.click();
          setFeedback(`Выбрано: ${label}`);
        }
      } else {
        const target = nearestObject(grabX, grabY);
        const id = target?.dataset.boardObjectId;
        const object = id ? latestObjects.current.find(item => item.id === id) : null;
        if (target && id && object) {
          const bounds = target.getBoundingClientRect();
          cameraHandDrags.current.set(hand.id, { id, offsetX: palmX - bounds.left, offsetY: palmY - bounds.top, width: target.offsetWidth, height: target.offsetHeight });
          lastHoveredObjectId.current = id;
          target.classList.add('camera-controlled-object');
        }
      }
    }
    const activeDrag = cameraHandDrags.current.get(hand.id);
    if (hand.grabbing && activeDrag) {
      const scale = latestObjects.current.find(item => item.id === activeDrag.id)?.scale ?? 1;
      const layoutLeftOffset = activeDrag.offsetX - activeDrag.width * (scale - 1) / 2;
      const layoutTopOffset = activeDrag.offsetY - activeDrag.height * (scale - 1) / 2;
      const x = Math.min(100, Math.max(0, (palmX - boardRect.left - layoutLeftOffset) / boardRect.width * 100));
      const y = Math.min(100, Math.max(0, (palmY - boardRect.top - layoutTopOffset) / boardRect.height * 100));
      const next = latestObjects.current.map(item => item.id === activeDrag.id ? { ...item, x, y } : item);
      latestObjects.current = next;
      const moved = next.find(item => item.id === activeDrag.id);
      if (moved) {
        const element = board.querySelector<HTMLElement>(`[data-board-object-id="${CSS.escape(moved.id)}"]`);
        if (element) { element.classList.add('camera-controlled-object'); element.style.left = `${moved.x}%`; element.style.top = `${moved.y}%`; }
        const lastSentAt = cameraLastSentAt.current.get(moved.id) ?? 0;
        if (now - lastSentAt >= GESTURE_CONFIG.boardUpdateIntervalMs && dragSocket.current?.readyState === WebSocket.OPEN) { dragSocket.current.send(JSON.stringify({ type: 'drag', object: moved, pageNumber: pageNumberRef.current })); cameraLastSentAt.current.set(moved.id, now); }
      }
    }
    if (hand.justReleased && activeDrag) {
      cameraHandDrags.current.delete(hand.id);
      const object = latestObjects.current.find(item => item.id === activeDrag.id);
      board.querySelector<HTMLElement>(`[data-board-object-id="${CSS.escape(activeDrag.id)}"]`)?.classList.remove('camera-controlled-object');
      if (object) {
        setObjects(latestObjects.current);
        if (dragSocket.current?.readyState === WebSocket.OPEN) dragSocket.current.send(JSON.stringify({ type: 'drag', object, pageNumber: pageNumberRef.current }));
        void persistOperation({ operation: 'upsert', object });
      }
    }
    renderHandCursors([hand]);
  }
  return <section className="board-section" ref={boardControlRef}><div className="board-toolbar"><div><span className={`board-live ${connectionState}`}><i />{connectionState === 'connected' ? `В СЕССИИ · ${participants.filter(item => item.connected).length} УЧАСТНИКОВ` : connectionState === 'connecting' ? 'ПОДКЛЮЧЕНИЕ…' : connectionState === 'reconnecting' ? 'ПЕРЕПОДКЛЮЧЕНИЕ…' : 'УРОК ЗАВЕРШЁН'}<small className={`board-sync-state ${boardSyncState}`}>{boardSyncState === 'connected' ? 'Доска синхронизирована' : boardSyncState === 'connecting' ? 'Синхронизация…' : 'Восстанавливаем связь…'}</small></span><h3>{lesson.className}: {lesson.title}</h3><div className="participant-list">{participants.map(person => { const raised = Boolean(raisedStudents[person.userId]); return <span key={person.userId} className={`participant-chip ${person.connected ? 'online' : ''} ${raised ? 'has-raised-hand' : ''}`} title={`${person.name}${person.role === 'teacher' ? ' · преподаватель' : ''}`}><i />{person.role === "student" && <span className="participant-avatar">{initials(person.name)}</span>}{raised && <b>✋</b>}{raised && user.role === 'teacher' ? <button className="raised-hand-clear" onClick={() => dragSocket.current?.send(JSON.stringify({ type: 'raise_hand_reset', userId: person.userId }))} title="Сбросить поднятую руку">{person.name} · сбросить</button> : person.name === user.name ? 'Вы' : person.name}</span>; })}</div></div><div className="board-tools"><button className="board-fullscreen-button" data-camera-action="toggle-fullscreen" onClick={() => void toggleFullscreen()} title={fullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'} aria-label={fullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button><div className="board-page-control" aria-label="Листы доски" title="Листание доски"><button data-camera-action="previous-page" onClick={() => void navigatePage('previous')} disabled={pageNumber <= 1 || connectionState === 'ended'} aria-label="Предыдущий лист" title="Предыдущий лист"><ChevronLeft size={16} /></button><span>Лист {pageNumber} / {pageCount}</span><button data-camera-action="next-page" onClick={() => void navigatePage('next')} disabled={connectionState === 'ended'} aria-label="Следующий лист" title="Следующий лист"><ChevronRight size={16} /></button></div><CameraHandControl active={controlMode === 'camera'} victoryScrollEnabled={storageModalOpen} onActiveChange={active => setControlMode(active ? 'camera' : 'mouse')} onFrame={handleHandFrame} disabled={connectionState === 'ended'} onAction={message => { if (message) { lastHandAction.current = message; handFeedbackUntil.current = performance.now() + GESTURE_CONFIG.feedbackDurationMs; setHandAction(message); } }} onRaiseHand={user.role === 'student' ? () => { if (!studentRaised.current) { studentRaised.current = true; if (dragSocket.current?.readyState === WebSocket.OPEN) dragSocket.current.send(JSON.stringify({ type: 'raise_hand' })); else pendingRaiseHand.current = true; } } : undefined} /><button data-camera-action="add-note" onClick={addNote} disabled={connectionState === 'ended'}><Plus size={16} />Заметка</button><button data-camera-action="open-storage" onClick={() => setStorageModalOpen(true)}><Image size={16} />Из хранилища</button>{user.role === 'teacher' && <button className="board-end-button" data-camera-action="end-lesson" onClick={onRequestEnd}><CircleStop size={15} />Завершить урок</button>}</div></div>{user.role === 'student' && raisedStudents[user.id] && <div className="raised-hand-student-message">✋ Рука поднята — преподаватель видит вас</div>}{user.role === 'teacher' && Object.entries(raisedStudents).length > 0 && <div className="board-raised-hand-alerts" aria-live="polite">{Object.entries(raisedStudents).map(([studentId, studentName]) => <div className="board-raised-hand-alert" key={studentId} role="status"><span className="board-raised-hand-icon">✋</span><span className="board-raised-hand-copy"><b>Ученик поднял руку</b><small>{studentName}</small></span><button data-camera-action={`dismiss-raised-hand-${studentId}`} onClick={() => dragSocket.current?.send(JSON.stringify({ type: 'raise_hand_reset', userId: studentId }))} aria-label={`Сбросить поднятую руку: ${studentName}`}>Сбросить</button></div>)}</div>}<div className={`shared-board ${connectionState === 'ended' ? 'board-readonly' : ''}`} ref={boardRef}>{handAction && <div className="board-hand-feedback" role="status" aria-live="polite">{handAction}</div>}<div key={pageNumber} className={`board-sheet-transition ${pageTransition ? `enter-${pageTransition}` : ""}`}>
    {!objects.length && <div className="board-hint"><div className="board-hint-icon"><GraduationCap size={24} /></div><b>{loading ? 'Загружаем доску…' : 'Доска готова к работе'}</b><span>{controlMode === 'camera' ? 'Ведите ладонь над действием и сожмите кулак, чтобы выбрать его.' : 'Добавляйте заметки, перетаскивайте их по доске и делитесь идеями.'}</span><div className="board-hint-actions"><button className="board-hint-primary" data-camera-action="add-note" onClick={addNote} disabled={loading || connectionState === 'ended'}><Plus size={16} />Добавить заметку</button><button className="board-hint-secondary" data-camera-action="open-storage" onClick={() => setStorageModalOpen(true)} disabled={connectionState === 'ended'}><Image size={16} />Добавить из хранилища</button></div><div className="board-control-mode"><span>Режим управления</span><div role="group" aria-label="Режим управления доской"><button className={controlMode === 'mouse' ? 'is-selected' : ''} onClick={() => setControlMode('mouse')} disabled={connectionState === 'ended'} data-camera-action="mode-mouse" aria-pressed={controlMode === 'mouse'}><MousePointer2 size={14} />Мышь</button><button className={controlMode === 'camera' ? 'is-selected' : ''} onClick={() => setControlMode('camera')} disabled={connectionState === 'ended'} data-camera-action="mode-camera" aria-pressed={controlMode === 'camera'}><Camera size={14} />Камера</button></div></div></div>}
    {objects.map(object => <div key={object.id} data-board-object-id={object.id} className={`board-object object-${object.kind} note-${object.color ?? 'yellow'}`} style={{ left: `${object.x}%`, top: `${object.y}%`, transform: `scale(${object.scale ?? 1})`, transformOrigin: 'center center' }} onPointerDown={event => { if (connectionState !== 'ended') startDrag(event, object); }} onPointerMove={moveDrag} onPointerUp={endDrag} onDoubleClick={() => connectionState !== 'ended' && void save(latestObjects.current.filter(item => item.id !== object.id))}>{object.assetId && mediaUrls[object.assetId] ? object.kind === 'video' ? <video className="board-media" src={mediaUrls[object.assetId]} controls draggable={false} /> : <img className="board-media" src={mediaUrls[object.assetId]} alt={object.label} draggable={false} /> : <span>{object.kind === 'image' ? <Image size={17} /> : object.kind === 'video' ? <FileVideo2 size={17} /> : '✦'}</span>}<b>{object.label}</b><small>{connectionState === 'ended' ? 'урок завершён' : 'перетащите · двойной клик — удалить'}</small></div>)}
    </div></div>
    {storageModalOpen && <div className="board-storage-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setStorageModalOpen(false); }}><section className="board-storage-modal" role="dialog" aria-modal="true" aria-labelledby="board-storage-title"><header><div><span className="board-storage-eyebrow">МАТЕРИАЛЫ УРОКА</span><h2 id="board-storage-title">Добавить из хранилища</h2><p>Выберите изображение или видео, чтобы разместить его на доске.</p></div><button className="board-storage-close" data-camera-action="modal-close" onClick={() => setStorageModalOpen(false)} aria-label="Закрыть"><X size={18} /></button></header><div className="board-storage-scroll" ref={storageModalScroll}>{assets.length ? <div className="board-storage-grid">{assets.map(asset => <button className="board-storage-asset" data-camera-action="choose-asset" key={asset.id} onClick={() => addAssetToBoard(asset)} title={`Добавить ${asset.filename}`}><span className="board-storage-preview">{mediaUrls[asset.id] ? asset.contentType.startsWith('video/') ? <video src={mediaUrls[asset.id]} muted preload="metadata" /> : <img src={mediaUrls[asset.id]} alt="" /> : asset.contentType.startsWith('video/') ? <FileVideo2 size={28} /> : <Image size={28} />}</span><b>{asset.filename}</b><small>{asset.contentType.startsWith('video/') ? 'Видео' : 'Изображение'} · {formatDate(asset.createdAt)}</small></button>)}</div> : <div className="board-storage-empty"><span><Image size={24} /></span><b>В хранилище пока пусто</b><p>Сначала загрузите изображение или видео в хранилище учителя.</p><button className="primary-button compact" data-camera-action="modal-upload" onClick={onOpenStorage}>Открыть хранилище</button></div>}</div><footer><span>{controlMode === 'camera' ? 'Курсор ладони · сожмите кулак для выбора · V вверх/вниз для прокрутки' : 'Можно выбрать материал мышью или включить управление камерой'}</span><button className="board-storage-done" data-camera-action="modal-close" onClick={() => setStorageModalOpen(false)}>Готово</button></footer></section></div>}
    {endConfirmationOpen && <div className="board-end-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !endingLesson) onCancelEnd(); }}><section className="board-end-confirm" role="dialog" aria-modal="true" aria-labelledby="end-lesson-title"><button className="board-end-confirm-close" data-camera-action="end-cancel" onClick={onCancelEnd} disabled={endingLesson} aria-label="Отмена"><X size={17} /></button><span className="board-end-confirm-icon"><CircleStop size={22} /></span><h2 id="end-lesson-title">Завершить урок?</h2><p>Урок завершится для всех участников. Доска сохранится, а подключение будет закрыто.</p><footer><button className="board-end-cancel" data-camera-action="end-cancel" onClick={onCancelEnd} disabled={endingLesson}>Отмена</button><button className="board-end-confirm-action" data-camera-action="end-confirm" onClick={onConfirmEnd} disabled={endingLesson}>{endingLesson ? 'Завершаем…' : 'Завершить урок'}</button></footer></section></div>}
    <div className="board-hand-cursors" ref={handCursorLayer} />
  </section>;
}

function ProfilePage({ user, onSettings }: { user: User; onSettings: () => void }) {
  return <div className="page-content"><PageHeading eyebrow="ВАШ АККАУНТ" title="Профиль" description="Личные данные вашего аккаунта." /><div className="profile-layout"><section className="surface-card profile-card"><div className="profile-banner"><span className="avatar profile-avatar">{initials(user.name)}</span><div><span className="role-tag">{user.role === 'teacher' ? 'Преподаватель' : 'Ученик'}</span><h2>{user.name}</h2><p>{user.email}</p></div><button className="settings-shortcut" onClick={onSettings}><Settings size={18} /></button></div><div className="profile-data"><div><span>Имя</span><b>{user.name}</b></div><div><span>Электронная почта</span><b>{user.email}</b></div><div><span>Роль</span><b>{user.role === 'teacher' ? 'Преподаватель' : 'Ученик'}</b></div></div></section></div><button className="subtle-settings-link" onClick={onSettings}><Settings size={17} />Настройки профиля <ChevronRight size={15} /></button></div>;
}

function SettingsPage({ user, onSave }: { user: User; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="page-content"><PageHeading eyebrow="УПРАВЛЕНИЕ АККАУНТОМ" title="Настройки" description="Настройки профиля и личных данных." /><section className="surface-card settings-card"><div className="settings-card-title"><div className="settings-gear"><Settings size={20} /></div><div><h3>Данные профиля</h3><p>Измените имя, которое видят ученики и преподаватель.</p></div></div><form className="settings-form" onSubmit={onSave}><label><span>Имя и фамилия <i className="required-mark">*</i></span><input name="name" defaultValue={user.name} required minLength={2} maxLength={80} /><small className="field-error">Укажите имя и фамилию.</small></label><label><span>Электронная почта</span><input value={user.email} readOnly /></label><p className="required-hint"><span className="required-mark">*</span> Обязательное поле</p><button className="primary-button compact" type="submit">Сохранить изменения <Check size={17} /></button></form></section></div>;
}

function ClassesPage({ user, classes, selectedClass, onChoose, onCreate, onDelete, onJoinClass }: { user: User; classes: Classroom[]; selectedClass: Classroom | null; onChoose: (c: Classroom) => void; onCreate: (event: FormEvent<HTMLFormElement>) => void; onDelete: (classroom: Classroom) => void; onJoinClass: (event: FormEvent<HTMLFormElement>) => void }) {
  const [detail, setDetail] = useState<{ id: string; name: string; inviteCode: string | null; students: { id: string; name: string; email: string; online: boolean }[] } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
    if (!selectedClass) { setDetail(null); return; }
    let cancelled = false;
    const loadDetails = () => { api<typeof detail>(`/classes/${selectedClass.id}`).then(result => { if (!cancelled) setDetail(result); }).catch(() => { if (!cancelled) setDetail(null); }); };
    loadDetails();
    const timer = window.setInterval(loadDetails, 12000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedClass]);
  const inviteLink = detail?.inviteCode ? `${window.location.origin}/?invite=${encodeURIComponent(detail.inviteCode)}` : '';
  async function copyClassInvite() {
    if (!inviteLink) return;
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true); window.setTimeout(() => setCopied(false), 2200); }
    catch { setCopied(false); }
  }
  const createClassForm = <form className="create-class-form" onSubmit={onCreate}><label className="required-input"><span>Название класса <i>*</i></span><input name="className" placeholder="Например, Математика 7А" required minLength={2} /><small className="field-error">Укажите название класса (минимум 2 символа).</small></label><button className="primary-button compact" type="submit"><Plus size={17} />Создать класс</button></form>;
  const joinClassForm = <form className="join-class-form" onSubmit={onJoinClass}><label className="required-input"><span>Код приглашения <i>*</i></span><input name="inviteCode" placeholder="Введите код класса" aria-label="Код приглашения в класс" required minLength={4} /><small className="field-error">Введите код приглашения.</small></label><button className="primary-button compact" type="submit">Присоединиться <ChevronRight size={16} /></button></form>;
  return <div className="page-content">
    <PageHeading eyebrow="УПРАВЛЕНИЕ ОБУЧЕНИЕМ" title={user.role === 'teacher' ? 'Мои классы' : 'Мой класс'} description={user.role === 'teacher' ? 'Классы и ученики, приглашённые на занятия.' : 'Ученики и преподаватель вашего класса.'} />
    {!classes.length ? <section className="classes-empty">
      <div className="history-empty-icon"><UsersRound size={23} /></div>
      <h2>{user.role === 'teacher' ? 'Классов пока нет' : 'Вы пока не состоите в классе'}</h2>
      <p>{user.role === 'teacher' ? 'Создайте класс, чтобы пригласить учеников и планировать совместные уроки.' : 'Введите код из ссылки-приглашения, чтобы присоединиться к классу преподавателя.'}</p>
      {user.role === 'teacher' ? createClassForm : joinClassForm}
    </section> : <>
      {user.role === 'teacher' && createClassForm}
      <div className="class-layout"><div className="class-list">{classes.map(classroom => <button className={`class-card ${selectedClass?.id === classroom.id ? 'class-selected' : ''}`} key={classroom.id} onClick={() => onChoose(classroom)}><span className="class-card-icon"><UsersRound size={21} /></span><span><b>{classroom.name}</b><small>{classroom.studentCount} {classroom.studentCount === 1 ? 'ученик' : 'учеников'}</small></span><ChevronRight size={17} /></button>)}</div>{detail && <section className="surface-card roster-card"><div className="roster-heading"><div><span className="role-tag">ВАШ КЛАСС</span><h2>{detail.name}</h2></div><div className="roster-actions"><span className="student-count">{detail.students.length} уч.</span>{user.role === 'teacher' && <button className="delete-class-button" onClick={() => selectedClass && onDelete(selectedClass)} title="Удалить класс" aria-label={`Удалить класс ${detail.name}`}><Trash2 size={16} /></button>}</div></div>{user.role === 'teacher' && <div className="class-invite-panel"><div className="class-invite-heading"><div className="invite-card-icon"><UsersRound size={19} /></div><div><b>Ссылка для регистрации</b><span>Зарегистрировавшиеся ученики сразу попадут в этот класс.</span></div></div><div className="invite-link-row"><input readOnly value={inviteLink || 'Готовим ссылку…'} aria-label={`Ссылка для регистрации в классе ${detail.name}`} /><button onClick={() => void copyClassInvite()} disabled={!inviteLink}><Copy size={15} />{copied ? 'Скопировано' : 'Копировать'}</button></div><span className="invite-code-caption">Код класса: <b>{detail.inviteCode ?? '—'}</b></span></div>}<div className="roster-list">{detail.students.map((student, index) => <div className="roster-person" key={student.id}><span className={`avatar student-avatar student-color-${index % 4}`}>{initials(student.name)}</span><span><b>{student.name}</b><small>{student.email}</small></span>{student.online && <i className="status-dot" title="В сети" aria-label="В сети" />}</div>)}{detail.students.length === 0 && <div className="roster-empty"><UsersRound size={25} /><b>Пока нет учеников</b><span>{user.role === 'teacher' ? 'Скопируйте ссылку регистрации в этом классе.' : 'Список появится, когда к классу присоединятся ученики.'}</span></div>}</div></section>}</div>
    </>}
  </div>;
}

function HistoryPage({ lessons, userRole }: { lessons: Lesson[]; userRole: User['role'] }) {
  return <div className="page-content"><PageHeading eyebrow="ПРОШЕДШИЕ ЗАНЯТИЯ" title="История уроков" description="Завершённые занятия. Подключение к ним закрыто, данные доски сохранены." />{lessons.length ? <section className="history-list">{lessons.map(lesson => <article className="history-row" key={lesson.id}><div className={`history-type-icon ${lesson.lessonType === 'ad_hoc' ? 'ad-hoc' : ''}`}><BookOpen size={19} /></div><div className="history-info"><b>{lesson.title}</b><span>{lesson.className} · {formatDate(lesson.startsAt)} · {formatTime(lesson.startsAt)}</span></div><span className={`history-kind ${lesson.lessonType}`}>{lesson.lessonType === 'ad_hoc' ? 'Внеплановый' : 'По расписанию'}</span><span className="history-ended"><Check size={14} />Завершён{lesson.endedAt ? ` · ${formatTime(lesson.endedAt)}` : ''}</span></article>)}</section> : <div className="history-empty"><div className="history-empty-icon"><History size={23} /></div><h2>История пока пуста</h2><p>Завершённые уроки появятся здесь. Внеплановые занятия не отображаются в расписании.</p></div>}</div>;
}

function SchedulePage({ user, classes, rules, lessons, onSaveRule, onDeleteOccurrence, onJoin }: { user: User; classes: Classroom[]; rules: ScheduleRule[]; lessons: Lesson[]; onSaveRule: (rule: ScheduleRule | null, payload: { classId: string; dayOfWeek: number; startTime: string }) => Promise<ScheduleRule | null>; onDeleteOccurrence: (rule: ScheduleRule, date: string) => void; onJoin: (lesson: Lesson) => void }) {
  const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  const [selectedSlot, setSelectedSlot] = useState<{ dayOfWeek: number; date: string; startTime: string } | null>(null);
  const [selectedClassId, setSelectedClassId] = useState('');
  const [saving, setSaving] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const weekDays = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + weekOffset * 7);
    return Array.from({ length: 7 }, (_, index) => { const date = new Date(monday); date.setDate(monday.getDate() + index); return date; });
  }, [weekOffset]);
  const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const weekTitle = `${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(weekDays[0])} — ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(weekDays[6])}`;
  const timeRows = [...new Set([...Array.from({ length: 13 }, (_, index) => index + 8), ...rules.map(rule => Number(rule.startTime.slice(0, 2)))])].sort((a, b) => a - b);
  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSlot || !selectedClassId) return;
    setSaving(true);
    const saved = await onSaveRule(null, { classId: selectedClassId, dayOfWeek: selectedSlot.dayOfWeek, startTime: selectedSlot.startTime });
    if (saved) { setSelectedSlot(null); setSelectedClassId(''); }
    setSaving(false);
  }
  return <div className="page-content schedule-page">
    <PageHeading eyebrow="ПЛАНИРОВАНИЕ" title="Расписание" description={user.role === 'teacher' ? 'Настройте повторяющиеся уроки: день недели, класс и время начала.' : 'Дни и время занятий вашего класса.'} />
    {user.role === 'teacher' && !classes.length && <div className="history-empty"><div className="history-empty-icon"><CalendarDays size={23} /></div><h2>Сначала создайте класс</h2><p>Чтобы настроить расписание, нужен класс, для которого будут проходить уроки.</p></div>}
    <section className="schedule-calendar-section"><div className="schedule-calendar-heading"><div><h2>Занятия по неделям</h2><span>{weekTitle}</span></div><div className="week-control"><button onClick={() => setWeekOffset(value => value - 1)} aria-label="Предыдущая неделя"><ChevronLeft size={17} /></button><button className="today-button" onClick={() => setWeekOffset(0)}>Сегодня</button><button onClick={() => setWeekOffset(value => value + 1)} aria-label="Следующая неделя"><ChevronRight size={17} /></button></div></div>
      <div className="schedule-calendar-scroll"><div className="schedule-week-grid"><div className="schedule-grid-corner" />{weekDays.map(date => <div className={`schedule-grid-day ${date.toDateString() === new Date().toDateString() ? 'is-today' : ''}`} key={date.toISOString()}><span>{new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(date)}</span><b>{date.getDate()}</b></div>)}{timeRows.map(hour => <div className="schedule-grid-row" key={hour}><span className="schedule-grid-hour">{String(hour).padStart(2, '0')}:00</span>{weekDays.map(date => {
        const key = dateKey(date);
        const events = rules.filter(rule => rule.dayOfWeek === (date.getDay() + 6) % 7 && !(rule.excludedDates ?? []).includes(key) && Number(rule.startTime.slice(0, 2)) === hour);
        return <div className={`schedule-grid-cell ${events.length ? 'has-events' : ''}`} key={`${key}-${hour}`}>{events.map(rule => {
          const lesson = lessons.find(item => item.scheduleRuleId === rule.id && item.occurrenceDate === key);
          return <article className={`schedule-grid-event ${lesson?.status === 'live' ? 'is-live' : ''}`} key={rule.id}><b>{rule.className}</b><span>{rule.startTime} · {rule.title}</span>{lesson?.status === 'live' && <button onClick={() => onJoin(lesson)}>Подключиться</button>}{user.role === 'teacher' && (!lesson || lesson.status === 'scheduled') && <button className="schedule-event-delete" title="Убрать урок только в этот день" aria-label={`Удалить урок ${dateKey(date)}`} onClick={() => onDeleteOccurrence(rule, key)}><Trash2 size={12} /></button>}</article>;
        })}{user.role === 'teacher' && classes.length > 0 && <button className="schedule-grid-add" aria-label={`Добавить урок: ${weekdays[(date.getDay() + 6) % 7]}, ${String(hour).padStart(2, '0')}:00`} onClick={() => { setSelectedSlot({ dayOfWeek: (date.getDay() + 6) % 7, date: key, startTime: `${String(hour).padStart(2, '0')}:00` }); setSelectedClassId(''); }}><Plus size={17} /></button>}</div>;
      })}</div>)}</div></div>
    </section>
    {user.role === 'teacher' && classes.length > 0 && <p className="schedule-footnote"><Clock3 size={15} />Нажмите «+» в ячейке, чтобы добавить еженедельный урок. Корзина убирает только выбранную дату.</p>}
    {selectedSlot && <div className="schedule-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedSlot(null); }}><form className="schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-modal-title" onSubmit={event => void createRule(event)}><button type="button" className="schedule-modal-close" aria-label="Закрыть" onClick={() => setSelectedSlot(null)}><X size={17} /></button><span className="schedule-modal-eyebrow">НОВОЕ ЗАНЯТИЕ</span><h2 id="schedule-modal-title">{weekdays[selectedSlot.dayOfWeek]}, {selectedSlot.startTime}</h2><p>Занятие будет повторяться каждую неделю в это время.</p><label className="schedule-rule-field"><span>Класс <i>*</i></span><select required autoFocus value={selectedClassId} onChange={event => setSelectedClassId(event.target.value)}><option value="">Выберите класс</option>{classes.map(classroom => <option key={classroom.id} value={classroom.id}>{classroom.name}</option>)}</select></label><button className="primary-button compact schedule-modal-save" type="submit" disabled={!selectedClassId || saving}><Check size={15} />{saving ? 'Сохраняем…' : 'Сохранить'}</button></form></div>}
  </div>;
}
function StoragePage({ assets, inputRef, onUpload }: { assets: Asset[]; inputRef: React.RefObject<HTMLInputElement | null>; onUpload: (file?: File) => void }) {
  return <div className="page-content"><PageHeading eyebrow="МАТЕРИАЛЫ УРОКА" title="Хранилище" description="Загружайте изображения и видео для использования на уроках." /><section className="upload-dropzone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); onUpload(event.dataTransfer.files[0]); }}><div className="upload-icon"><Image size={22} /></div><b>Добавьте материалы для уроков</b><span>Перетащите изображение или видео сюда или выберите файл</span><button className="outline-button upload-button" onClick={() => inputRef.current?.click()}><Plus size={17} />Выбрать файл</button><small>Поддерживаются форматы изображений и видео</small><input ref={inputRef} hidden type="file" accept="image/*,video/*" onChange={event => onUpload(event.target.files?.[0])} /></section><div className="storage-heading"><h3>Ваши материалы</h3><span>{assets.length} файлов</span></div>{assets.length ? <div className="asset-grid">{assets.map(asset => <article className="asset-card" key={asset.id}><div className="asset-preview">{asset.contentType.startsWith('video/') ? <FileVideo2 size={30} /> : <Image size={30} />}</div><div className="asset-caption"><b>{asset.filename}</b><small>{formatDate(asset.createdAt)}</small></div></article>)}</div> : <div className="empty-card storage-empty">Хранилище пока пустое. Загрузите изображение или видео, чтобы использовать на доске.</div>}</div>;
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) { return <div className="page-heading"><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>; }
