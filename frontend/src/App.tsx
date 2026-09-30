import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, GraduationCap, KeyRound, LockKeyhole, Mail, UserRound, UsersRound } from 'lucide-react';
import illustration from './assets/classroom-illustration.png';
import Dashboard, { type User } from './Dashboard';

type Mode = 'login' | 'register';
type Role = 'teacher' | 'student';
const API_URL = new URL(import.meta.env.VITE_API_URL ?? '/api', window.location.origin).toString().replace(/\/$/, '');

function clearInviteFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('invite')) return;
  url.searchParams.delete('invite');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export default function App() {
  const inviteFromUrl = new URLSearchParams(window.location.search).get('invite') ?? '';
  const [mode, setMode] = useState<Mode>(inviteFromUrl ? 'register' : 'login');
  const [role, setRole] = useState<Role>(inviteFromUrl ? 'student' : 'teacher');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(Boolean(localStorage.getItem('motionclass_token')));

  useEffect(() => {
    const token = localStorage.getItem('motionclass_token');
    if (!token) return;
    fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.detail); clearInviteFromUrl(); setUser(data.user); })
      .catch(() => localStorage.removeItem('motionclass_token'))
      .finally(() => setChecking(false));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const response = await fetch(`${API_URL}/auth/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, role: mode === 'register' ? role : undefined }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Не удалось выполнить запрос.');
      localStorage.setItem('motionclass_token', data.token);
      clearInviteFromUrl();
      setUser(data.user);
    } catch (problem) { setError(problem instanceof TypeError ? 'Не удалось связаться с сервером. Убедитесь, что API запущен.' : (problem as Error).message); }
    finally { setBusy(false); }
  }

  function logout() {
    const token = localStorage.getItem('motionclass_token');
    const connectionId = sessionStorage.getItem('motionclass_site_connection');
    if (token && connectionId) {
      void fetch(`${API_URL}/presence/leave`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
        keepalive: true,
      }).catch(() => undefined);
    }
    sessionStorage.removeItem('motionclass_site_connection');
    localStorage.removeItem('motionclass_token');
    window.location.replace(`${window.location.origin}/`);
  }
  function switchMode(next: Mode) { setMode(next); setError(''); }
  if (checking) return <div className="auth-loading"><span className="brand-mark"><GraduationCap size={25} /></span><span>Загружаем кабинет…</span></div>;
  if (user) return <Dashboard user={user} onLogout={logout} onUserChange={setUser} />;

  return <main className="page-shell">
    <section className="auth-panel" aria-label="Авторизация">
      <a className="brand" href="#home" aria-label="MotionClass — главная"><span className="brand-mark"><GraduationCap size={30} strokeWidth={2.5} /></span><span>Motion<span className="brand-accent">Class</span></span></a>
      <div className="form-content">
        <p className="eyebrow">ПРОСТРАНСТВО ДЛЯ ОБУЧЕНИЯ</p>
        <h1>{mode === 'login' ? 'С возвращением!' : 'Создайте аккаунт'}</h1>
        <p className="subtitle">{mode === 'login' ? 'Продолжайте создавать интерактивные уроки и управлять ими жестами' : 'Начните проводить интерактивные уроки вместе с MotionClass'}</p>
        <form onSubmit={handleSubmit} className="auth-form">
          {mode === 'register' && <>
            <label className="field"><UserRound size={19} /><input name="name" type="text" placeholder="Имя и фамилия" autoComplete="name" required minLength={2} /><span className="field-required-mark" aria-hidden="true">*</span><small className="field-error">Укажите имя и фамилию.</small></label>
            <fieldset className="role-picker"><legend>Я присоединяюсь как <span aria-hidden="true">*</span></legend><button type="button" className={`role-option ${role === 'teacher' ? 'selected' : ''}`} onClick={() => setRole('teacher')}><GraduationCap size={19} />Преподаватель</button><button type="button" className={`role-option ${role === 'student' ? 'selected' : ''}`} onClick={() => setRole('student')}><UsersRound size={18} />Ученик</button></fieldset>
            {role === 'student' && <label className="field"><KeyRound size={18} /><input name="inviteCode" type="text" placeholder="Код приглашения класса" defaultValue={inviteFromUrl} required autoComplete="off" /><span className="field-required-mark" aria-hidden="true">*</span><small className="field-error">Введите код приглашения.</small></label>}
          </>}
          <label className="field"><Mail size={19} /><input name="email" type="email" placeholder="Введите вашу почту" autoComplete="email" required /><span className="field-required-mark" aria-hidden="true">*</span><small className="field-error">Введите корректную почту.</small></label>
          <label className="field"><LockKeyhole size={19} /><input name="password" type={showPassword ? 'text' : 'password'} placeholder="Введите пароль" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'login' ? 5 : 8} /><span className="field-required-mark" aria-hidden="true">*</span><button className="icon-button" type="button" aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={20} /> : <Eye size={20} />}</button><small className="field-error">{mode === 'login' ? 'Введите пароль не короче 5 символов.' : 'Введите пароль не короче 8 символов.'}</small></label>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Подождите…' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}<ArrowRight size={20} /></button>
        </form>
        {mode === 'login' && <button className="text-link forgot" onClick={() => setError('Восстановление пароля появится в следующем обновлении.')}>Забыли пароль?</button>}
        <div className="divider"><span>{mode === 'login' ? 'или' : 'УЖЕ ЕСТЬ АККАУНТ?'}</span></div>
        <button className="outline-button" onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}><UserRound size={20} />{mode === 'login' ? 'Создать аккаунт' : 'Войти в аккаунт'}</button>
        {error && <p className="notice error" role="alert">{error}</p>}
      </div>
      <span className="panel-footer">© 2026 MotionClass</span>
    </section>
    <section className="visual-panel" aria-label="Интерактивное обучение"><div className="visual-wash" /><div className="visual-copy"><span className="visual-label">УЧИТЬСЯ — ЭТО ИНТЕРЕСНО</span><h2>Идеи оживают,<br />когда учимся вместе</h2><p>Создавайте уроки, делитесь знаниями и открывайте новое на общей интерактивной доске.</p></div><img className="hero-illustration" src={illustration} alt="Учитель и ученики вместе работают над интерактивным уроком" /></section>
  </main>;
}
