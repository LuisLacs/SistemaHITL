import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import '../styles/scientific-ui.css';


export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('ui-theme') || 'light');
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ui-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
      const response = await axios.post(`${BASE_URL}/api/auth/login`, {
        email,
        password
      });

      localStorage.setItem('token', response.data.token);
      localStorage.setItem('expertId', response.data.usuario.id);
      localStorage.setItem('expertEmail', email);

      navigate('/anotador');
    } catch (err) {
      setError(err.response?.data?.error || 'Credenciales inválidas o servicio no disponible.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: 'var(--bg-app)',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: '24px'
    }}>
      {/* Barra superior discreta con selector de tema */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', maxWidth: '1200px', width: '100%', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '12px', fontWeight: '700', letterSpacing: '0.06em', color: 'var(--text-primary)' }}>
            CIDESI
          </span>
          <span style={{ color: 'var(--border-color)' }}>|</span>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            División de Posgrado e Investigación
          </span>
        </div>

        <button onClick={toggleTheme} className="btn btn-outline" title="Alternar tema visual">
          {theme === 'light' ? (
            <svg className="icon-svg" viewBox="0 0 24 24">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : (
            <svg className="icon-svg" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          )}
          <span>{theme === 'light' ? 'Modo Oscuro' : 'Modo Claro'}</span>
        </button>
      </div>

      {/* Contenedor central de autenticación */}
      <div style={{
        width: '100%',
        maxWidth: '380px',
        margin: '0 auto',
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
        padding: '32px',
        boxShadow: 'var(--shadow-sm)'
      }}>
        <div style={{ marginBottom: '24px' }}>
          <div style={{
            fontSize: '11px',
            fontWeight: '600',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--accent-primary)',
            marginBottom: '6px'
          }}>
            Plataforma Termográfica HITL
          </div>
          <h1 style={{ margin: '0 0 6px 0', fontSize: '20px', fontWeight: '600', color: 'var(--text-primary)' }}>
            Acceso de Investigador
          </h1>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
            Validación y segmentación de piscina fundida
          </p>
        </div>

        {error && (
          <div style={{
            backgroundColor: 'var(--danger-bg)',
            border: '1px solid var(--danger-border)',
            color: 'var(--danger-text)',
            padding: '10px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            marginBottom: '18px'
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: '500', color: 'var(--text-primary)', marginBottom: '6px' }}>
              Correo institucional
            </label>
            <input
              type="email"
              className="input-field"
              placeholder="nombre.apellido@cidesi.mx"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: '500', color: 'var(--text-primary)', marginBottom: '6px' }}>
              Contraseña
            </label>
            <input
              type="password"
              className="input-field"
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary"
            style={{ width: '100%', height: '38px', marginTop: '4px', fontSize: '13px' }}
          >
            {loading ? 'Autenticando...' : 'Iniciar sesión'}
          </button>

        </form>
        <div style={{
          marginTop: '20px',
          paddingTop: '16px',
          borderTop: '1px solid var(--border-color)',
          textAlign: 'center',
          fontSize: '12px'
        }}>
          <span style={{ color: 'var(--text-secondary)' }}>¿Nuevo investigador en la plataforma? </span>
          <Link to="/register" style={{ color: 'var(--accent-primary)', textDecoration: 'none', fontWeight: '600' }}>
            Registrar cuenta
          </Link>
        </div>
      </div>

      {/* Pie de página técnico minimalista */}
      <footer style={{
        maxWidth: '1200px',
        width: '100%',
        margin: '0 auto',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '11px',
        color: 'var(--text-muted)',
        borderTop: '1px solid var(--border-color)',
        paddingTop: '16px'
      }}>
        <span>Adquisición Radiométrica: FLIR A6751sc (640×512 px, 14-bit)</span>
        <span>Arquitectura de Persistencia: PostgreSQL / MongoDB Atlas</span>
      </footer>
    </div>
  );
}