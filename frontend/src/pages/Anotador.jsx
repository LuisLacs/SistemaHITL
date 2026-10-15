import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import '../styles/scientific-ui.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const API_URL = `${BASE_URL}/api/annotations`;

export default function Anotador() {
  const navigate = useNavigate();
  const [isAuthorized] = useState(!!localStorage.getItem('token'));
  const canvasRef = useRef(null);
  const inicioTiempoRef = useRef(null);
  const ultimoCentroExpertoRef = useRef(null);

  useEffect(() => {
    inicioTiempoRef.current = Date.now();
  }, []);

  const [theme, setTheme] = useState(localStorage.getItem('ui-theme') || 'dark');
  const [secuenciaActiva, setSecuenciaActiva] = useState(
    localStorage.getItem('hitl-secuencia') || 'RC3.ats'
  );

  const [loteFotogramas, setLoteFotogramas] = useState([]);
  const [indiceLote, setIndiceLote] = useState(
    Number(localStorage.getItem('hitl-indice-lote')) || 0
  );
  const [frameActual, setFrameActual] = useState(
    Number(localStorage.getItem('hitl-frame-actual')) || 1
  );
  const totalFrames = loteFotogramas.length > 0 ? loteFotogramas.length : 100;

  // Persistir el progreso del índice para no perder la posición al recargar
  useEffect(() => {
    localStorage.setItem('hitl-secuencia', secuenciaActiva);
    localStorage.setItem('hitl-indice-lote', String(indiceLote));
    localStorage.setItem('hitl-frame-actual', String(frameActual));
  }, [secuenciaActiva, indiceLote, frameActual]);

  const fotogramaActivo = loteFotogramas.length > 0 ? loteFotogramas[indiceLote] : null;
  const imgElement = fotogramaActivo ? fotogramaActivo.imgElement : null;
  const identificadorFrame = fotogramaActivo
    ? `${secuenciaActiva}_${fotogramaActivo.nombreArchivo.replace(/\.[^/.]+$/, '')}`
    : `${secuenciaActiva}_frame_${frameActual}`;

  const [umbralIsotermico, setUmbralIsotermico] = useState(218);
  const [recorteEstela, setRecorteEstela] = useState(true);
  const [plantillaExperto, setPlantillaExperto] = useState(null);

  // Control de flujo ergonómico: Auto-avanzar al guardar y detección de cambios sin guardar
  const [autoAvanzar, setAutoAvanzar] = useState(true);
  const [modificadoSinGuardar, setModificadoSinGuardar] = useState(false);

  const [poligonoIA, setPoligonoIA] = useState([]);
  const [poligono, setPoligono] = useState([]);
  const [mostrarGuiaIA, setMostrarGuiaIA] = useState(true);

  const [telemetriaPool, setTelemetriaPool] = useState({
    adMax: 7082,
    adPromedio: 6150,
    centroideX: 318,
    centroideY: 214,
    incertidumbre: 9.4
  });

  const [modoValidacion, setModoValidacion] = useState('Binaria');
  const [verticeArrastrado, setVerticeArrastrado] = useState(null);

  const [estadoBD, setEstadoBD] = useState('Pendiente');
  const [cursorPos, setCursorPos] = useState({ x: 318, y: 214, counts: 6820 });
  const [guardando, setGuardando] = useState(false);
  const [mensajeEstado, setMensajeEstado] = useState('');

  const [mostrarMetricas, setMostrarMetricas] = useState(false);
  const [resumenMetricas, setResumenMetricas] = useState({
    totalValidados: 0,
    tiempoPromedioSeg: 0,
    iouPromedio: 100,
    tasaConfirmacionDirecta: 0,
    tasaCorreccionHumana: 0
  });

  const [direccionSoldadura, setDireccionSoldadura] = useState('Derecha a Izquierda');
  const [material, setMaterial] = useState('Acero Inoxidable');
  const [cordones, setCordones] = useState(1);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ui-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!isAuthorized) {
      navigate('/login', { replace: true });
    }
  }, [isAuthorized, navigate]);

  const dibujarFuenteTermica = useCallback((ctx, width, height, imagenExplicita = imgElement) => {
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, width, height);

    if (imagenExplicita) {
      ctx.drawImage(imagenExplicita, 0, 0, width, height);
    } else {
      const seed = loteFotogramas.length > 0 ? indiceLote + 1 : frameActual;
      const offsetX = Math.sin(seed * 0.45) * 35;
      const offsetY = Math.cos(seed * 0.35) * 18;
      const cx = Math.round(280 + offsetX);
      const cy = Math.round(200 + offsetY);

      const gradExterior = ctx.createRadialGradient(cx, cy, 6, cx, cy, 82);
      gradExterior.addColorStop(0, 'rgba(255, 255, 255, 1)');
      gradExterior.addColorStop(0.38, 'rgba(230, 230, 230, 0.9)');
      gradExterior.addColorStop(0.68, 'rgba(95, 95, 95, 0.35)');
      gradExterior.addColorStop(1, 'rgba(5, 5, 5, 0)');
      ctx.fillStyle = gradExterior;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 74, 31, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - 26, cy - 11, 52, 22);
    }
  }, [imgElement, loteFotogramas.length, indiceLote, frameActual]);

  // =========================================================================
  // MOTOR DE SEGMENTACIÓN CON FRENTE DE ATAQUE DIRECCIONAL Y VENTANA LOCAL
  // =========================================================================
  const ejecutarPreSegmentacionIA = useCallback((
    umbralCustom = umbralIsotermico,
    imagenTarget = imgElement,
    usarRecorteCola = recorteEstela
  ) => {
    const offscreen = document.createElement('canvas');
    offscreen.width = 640;
    offscreen.height = 512;
    const ctx = offscreen.getContext('2d');

    dibujarFuenteTermica(ctx, 640, 512, imagenTarget);
    const imgData = ctx.getImageData(0, 0, 640, 512).data;

    const ancla = ultimoCentroExpertoRef.current;
    const xMinROI = ancla ? Math.max(30, ancla.x - 95) : 30;
    const xMaxROI = ancla ? Math.min(610, ancla.x + 95) : 610;
    const yMinROI = ancla ? Math.max(30, ancla.y - 65) : 30;
    const yMaxROI = ancla ? Math.min(482, ancla.y + 65) : 482;

    let maxLumGlobal = 0;
    for (let y = yMinROI; y < yMaxROI; y += 2) {
      for (let x = xMinROI; x < xMaxROI; x += 2) {
        const idx = (y * 640 + x) * 4;
        const lum = (imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3;
        if (lum > maxLumGlobal) maxLumGlobal = lum;
      }
    }

    if (maxLumGlobal < 40) return;

    const umbralNucleoPuro = Math.max(umbralCustom, maxLumGlobal * 0.95);
    let sumCoreY = 0;
    let countCore = 0;
    let minCoreX = 640;
    let maxCoreX = 0;
    let sumCoreX = 0;

    for (let y = yMinROI; y < yMaxROI; y++) {
      for (let x = xMinROI; x < xMaxROI; x++) {
        const idx = (y * 640 + x) * 4;
        const lum = (imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3;
        if (lum >= umbralNucleoPuro) {
          sumCoreX += x;
          sumCoreY += y;
          countCore++;
          if (x < minCoreX) minCoreX = x;
          if (x > maxCoreX) maxCoreX = x;
        }
      }
    }

    if (countCore === 0) return;

    let cy = Math.round(sumCoreY / countCore);
    let cx = Math.round(sumCoreX / countCore);

    const umbralEfectivo = Math.max(umbralCustom, maxLumGlobal * 0.86);
    let radioArriba = 6;
    let radioAbajo = 6;

    for (let r = 2; r < 60; r++) {
      const pyUp = Math.max(5, cy - r);
      const idxUp = (pyUp * 640 + cx) * 4;
      const lumUp = (imgData[idxUp] + imgData[idxUp + 1] + imgData[idxUp + 2]) / 3;
      if (lumUp >= umbralEfectivo) radioArriba = r;
      else if (r > radioArriba + 2) break;
    }

    for (let r = 2; r < 60; r++) {
      const pyDown = Math.min(506, cy + r);
      const idxDown = (pyDown * 640 + cx) * 4;
      const lumDown = (imgData[idxDown] + imgData[idxDown + 1] + imgData[idxDown + 2]) / 3;
      if (lumDown >= umbralEfectivo) radioAbajo = r;
      else if (r > radioAbajo + 2) break;
    }

    const radioBasePool = Math.min(24, Math.max(10, Math.round((radioArriba + radioAbajo) / 2)));

    const anchoManchaBlanca = maxCoreX - minCoreX;
    if (usarRecorteCola && anchoManchaBlanca > radioBasePool * 2.4) {
      if (direccionSoldadura === 'Derecha a Izquierda') {
        cx = Math.round(minCoreX + radioBasePool * 1.15);
      } else {
        cx = ancla
          ? Math.round(ancla.x * 0.65 + cx * 0.35)
          : Math.round(minCoreX + radioBasePool * 1.2);
      }
    }

    let sumYLocal = 0;
    let countYLocal = 0;
    for (let y = Math.max(20, cy - 35); y <= Math.min(490, cy + 35); y++) {
      const idx = (y * 640 + cx) * 4;
      const lum = (imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3;
      if (lum >= umbralEfectivo) {
        sumYLocal += y;
        countYLocal++;
      }
    }
    if (countYLocal > 0) {
      cy = Math.round(sumYLocal / countYLocal);
    }

    const numVertices = 10;
    const verticesDetectados = [];
    let sumLumPool = 0;
    let muestrasPool = 0;
    let bordeDifuso = 0;

    const maxRadioHorizontal = usarRecorteCola ? Math.round(radioBasePool * 1.35) : 120;
    const maxRadioVertical = usarRecorteCola ? Math.round(radioBasePool * 1.05) : 90;

    for (let i = 0; i < numVertices; i++) {
      const angulo = (i * 2 * Math.PI) / numVertices;
      const cos = Math.cos(angulo);
      const sin = Math.sin(angulo);

      const limiteElipse = Math.sqrt(
        Math.pow(maxRadioHorizontal * cos, 2) +
        Math.pow(maxRadioVertical * sin, 2)
      );
      const rMaxRayo = Math.round(limiteElipse);
      let ultimoRadioValido = Math.round(radioBasePool * 0.65);

      for (let r = 3; r <= rMaxRayo; r++) {
        const px = Math.round(cx + r * cos);
        const py = Math.round(cy + r * sin);
        if (px <= 5 || px >= 635 || py <= 5 || py >= 507) break;

        const idx = (py * 640 + px) * 4;
        const lum = (imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3;

        if (lum >= umbralEfectivo) {
          ultimoRadioValido = r;
          sumLumPool += lum;
          muestrasPool++;
        } else {
          if (lum >= umbralEfectivo - 25) bordeDifuso++;
          if (r > ultimoRadioValido + 2) break;
        }
      }

      verticesDetectados.push({
        x: Math.round(cx + ultimoRadioValido * cos),
        y: Math.round(cy + ultimoRadioValido * sin)
      });
    }

    const promedioLum = muestrasPool > 0 ? sumLumPool / muestrasPool : maxLumGlobal * 0.94;
    const adMax = Math.round(1017 + (maxLumGlobal / 255) * (7082 - 1017));
    const adPromedio = Math.round(1017 + (promedioLum / 255) * (7082 - 1017));
    const incertidumbreCalc = Number(Math.min(24.5, Math.max(6.5, 8 + (bordeDifuso / (numVertices * 3)) * 10)).toFixed(1));

    setPoligonoIA(verticesDetectados);
    setPoligono(verticesDetectados);
    setTelemetriaPool({
      adMax,
      adPromedio,
      centroideX: cx,
      centroideY: cy,
      incertidumbre: incertidumbreCalc
    });
    setModoValidacion('Binaria');
    setModificadoSinGuardar(false);
    inicioTiempoRef.current = Date.now();
  }, [dibujarFuenteTermica, umbralIsotermico, imgElement, recorteEstela, direccionSoldadura]);

  const calibrarDesdePoligonoExperto = (puntosExperto) => {
    if (!puntosExperto || puntosExperto.length < 3) return;
    const offscreen = document.createElement('canvas');
    offscreen.width = 640;
    offscreen.height = 512;
    const ctx = offscreen.getContext('2d');
    dibujarFuenteTermica(ctx, 640, 512, imgElement);
    const imgData = ctx.getImageData(0, 0, 640, 512).data;

    let sumaLumBorde = 0;
    puntosExperto.forEach((pt) => {
      const px = Math.max(0, Math.min(639, pt.x));
      const py = Math.max(0, Math.min(511, pt.y));
      const idx = (py * 640 + px) * 4;
      const lum = (imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3;
      sumaLumBorde += lum;
    });

    const nuevoUmbralAprendido = Math.max(170, Math.min(248, Math.round(sumaLumBorde / puntosExperto.length)));
    setUmbralIsotermico(nuevoUmbralAprendido);

    const cxExp = Math.round(puntosExperto.reduce((acc, p) => acc + p.x, 0) / puntosExperto.length);
    const cyExp = Math.round(puntosExperto.reduce((acc, p) => acc + p.y, 0) / puntosExperto.length);

    ultimoCentroExpertoRef.current = { x: cxExp, y: cyExp };

    const offsets = puntosExperto.map((p) => ({ dx: p.x - cxExp, dy: p.y - cyExp }));
    setPlantillaExperto(offsets);
  };

  const handleAplicarPlantillaExperto = () => {
    if (!plantillaExperto) return;
    const nuevosPuntos = plantillaExperto.map((off) => ({
      x: Math.max(0, Math.min(640, telemetriaPool.centroideX + off.dx)),
      y: Math.max(0, Math.min(512, telemetriaPool.centroideY + off.dy))
    }));
    setPoligono(nuevosPuntos);
    setModoValidacion('Poligono');
    setModificadoSinGuardar(true);
    setMensajeEstado('Contorno experto adaptado al centroide actual');
  };

  useEffect(() => {
    let cancelado = false;
    const gestionarCargaDeFrame = async () => {
      try {
        const res = await axios.get(`${API_URL}/frame/${encodeURIComponent(identificadorFrame)}`);
        if (!cancelado && res.data.existe && res.data.data) {
          const doc = res.data.data;
          setPoligonoIA(doc.poligonoPreEtiquetado?.length ? doc.poligonoPreEtiquetado : doc.poligono);
          setPoligono(doc.poligono || []);
          setModoValidacion(doc.tipoValidacion === 'Poligono' ? 'Poligono' : 'Binaria');
          setEstadoBD(doc.estado || 'Revisado');
          setModificadoSinGuardar(false);
          if (doc.metadatos) {
            setDireccionSoldadura(doc.metadatos.direccionSoldadura || 'Derecha a Izquierda');
            setMaterial(doc.metadatos.material || 'Acero Inoxidable');
            setCordones(doc.metadatos.numeroCordones || 1);
          }
          setMensajeEstado(`Validado en Atlas: ${identificadorFrame}`);
          inicioTiempoRef.current = Date.now();
          return;
        }
      } catch {
        // Continúa a pre-segmentación
      }

      if (!cancelado) {
        setEstadoBD('Pendiente');
        ejecutarPreSegmentacionIA(umbralIsotermico, imgElement, recorteEstela);
        setMensajeEstado(
          fotogramaActivo
            ? `Pre-etiquetado IA: ${fotogramaActivo.nombreArchivo}`
            : 'Pre-segmentación aplicada'
        );
      }
    };

    gestionarCargaDeFrame();
    return () => { cancelado = true; };
  }, [identificadorFrame, imgElement, fotogramaActivo, ejecutarPreSegmentacionIA, umbralIsotermico, recorteEstela]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  const handleSubirLoteImagenes = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const promesasCarga = files.map((file, idx) => {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          const img = new Image();
          img.onload = () => {
            resolve({
              idNumero: idx + 1,
              nombreArchivo: file.name,
              imgElement: img
            });
          };
          img.src = event.target.result;
        };
        reader.readAsDataURL(file);
      });
    });

    const imagenesCargadas = await Promise.all(promesasCarga);
    setLoteFotogramas(imagenesCargadas);

    // Si había un índice guardado dentro del rango del lote, restaurarlo automáticamente
    const indiceGuardado = Number(localStorage.getItem('hitl-indice-lote')) || 0;
    const indiceValido = indiceGuardado < imagenesCargadas.length ? indiceGuardado : 0;

    setIndiceLote(indiceValido);
    setFrameActual(indiceValido + 1);

    ejecutarPreSegmentacionIA(umbralIsotermico, imagenesCargadas[indiceValido].imgElement, recorteEstela);
    setMensajeEstado(`Lote cargado (${imagenesCargadas.length} frames). Posición restaurada en #${indiceValido + 1}`);
  };

  const calcularGeometria = (puntos) => {
    if (!puntos || puntos.length < 3) return { area: 0, perimetro: 0 };
    let area = 0;
    let perimetro = 0;
    const n = puntos.length;
    for (let i = 0; i < n; i++) {
      const p1 = puntos[i];
      const p2 = puntos[(i + 1) % n];
      area += p1.x * p2.y - p2.x * p1.y;
      perimetro += Math.hypot(p2.x - p1.x, p2.y - p1.y);
    }
    return {
      area: Math.round(Math.abs(area) / 2),
      perimetro: Math.round(perimetro)
    };
  };

  const geometria = calcularGeometria(poligono);
  const geometriaIA = calcularGeometria(poligonoIA);

  const calcularSimilitudIoU = () => {
    if (!poligonoIA.length || !poligono.length) return 100;
    if (JSON.stringify(poligonoIA) === JSON.stringify(poligono)) return 100;
    const maxArea = Math.max(geometria.area, geometriaIA.area, 1);
    const minArea = Math.min(geometria.area, geometriaIA.area);
    return Number(((minArea / maxArea) * 100).toFixed(1));
  };

  const iouActual = calcularSimilitudIoU();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    dibujarFuenteTermica(ctx, canvas.width, canvas.height, imgElement);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    if (mostrarGuiaIA && poligonoIA.length >= 3 && iouActual < 100) {
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(poligonoIA[0].x, poligonoIA[0].y);
      for (let i = 1; i < poligonoIA.length; i++) {
        ctx.lineTo(poligonoIA[i].x, poligonoIA[i].y);
      }
      ctx.closePath();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    if (poligono.length > 0) {
      ctx.beginPath();
      ctx.moveTo(poligono[0].x, poligono[0].y);
      for (let i = 1; i < poligono.length; i++) {
        ctx.lineTo(poligono[i].x, poligono[i].y);
      }
      if (poligono.length >= 3) {
        ctx.closePath();
        ctx.fillStyle = modoValidacion === 'Binaria'
          ? 'rgba(16, 185, 129, 0.18)'
          : 'rgba(2, 132, 199, 0.22)';
        ctx.fill();
      }
      ctx.strokeStyle = modoValidacion === 'Binaria' ? '#10b981' : '#38bdf8';
      ctx.lineWidth = 1.75;
      ctx.stroke();

      poligono.forEach((pt, idx) => {
        ctx.fillStyle = idx === 0 ? '#ffffff' : (modoValidacion === 'Binaria' ? '#10b981' : '#38bdf8');
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(telemetriaPool.centroideX - 5, telemetriaPool.centroideY);
    ctx.lineTo(telemetriaPool.centroideX + 5, telemetriaPool.centroideY);
    ctx.moveTo(telemetriaPool.centroideX, telemetriaPool.centroideY - 5);
    ctx.lineTo(telemetriaPool.centroideX, telemetriaPool.centroideY + 5);
    ctx.stroke();
  }, [poligono, poligonoIA, mostrarGuiaIA, modoValidacion, dibujarFuenteTermica, imgElement, telemetriaPool, iouActual]);

  const obtenerCoordenadasCanvas = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(640, Math.round(e.clientX - rect.left))),
      y: Math.max(0, Math.min(512, Math.round(e.clientY - rect.top)))
    };
  };

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    const { x, y } = obtenerCoordenadasCanvas(e);

    const idxExistente = poligono.findIndex((pt) => Math.hypot(pt.x - x, pt.y - y) < 8);
    if (idxExistente !== -1) {
      setModoValidacion('Poligono');
      setVerticeArrastrado(idxExistente);
      setModificadoSinGuardar(true);
    } else if (modoValidacion === 'Poligono') {
      setPoligono((prev) => [...prev, { x, y }]);
      setModificadoSinGuardar(true);
    }
  };

  const handleMouseMove = (e) => {
    const { x, y } = obtenerCoordenadasCanvas(e);

    if (verticeArrastrado !== null) {
      setPoligono((prev) =>
        prev.map((pt, idx) => (idx === verticeArrastrado ? { x, y } : pt))
      );
      setModificadoSinGuardar(true);
    }

    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      const pixel = ctx.getImageData(Math.min(x, 639), Math.min(y, 511), 1, 1).data;
      const luminancia = (pixel[0] + pixel[1] + pixel[2]) / (3 * 255);
      const counts = Math.round(1017 + luminancia * (7082 - 1017));
      setCursorPos({ x, y, counts });
    }
  };

  const handleMouseUp = () => {
    setVerticeArrastrado(null);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    const { x, y } = obtenerCoordenadasCanvas(e);
    const idxEliminar = poligono.findIndex((pt) => Math.hypot(pt.x - x, pt.y - y) < 10);
    if (idxEliminar !== -1) {
      setModoValidacion('Poligono');
      setPoligono((prev) => prev.filter((_, idx) => idx !== idxEliminar));
      setModificadoSinGuardar(true);
    }
  };

  // Navegación hacia adelante y hacia atrás
  const irAFotograma = useCallback((nuevoValorFrame) => {
    const frameClamped = Math.max(1, Math.min(totalFrames, nuevoValorFrame));
    if (loteFotogramas.length > 0) {
      setIndiceLote(frameClamped - 1);
      setFrameActual(frameClamped);
    } else {
      setFrameActual(frameClamped);
    }
  }, [totalFrames, loteFotogramas.length]);

  // Guardado en MongoDB Atlas con opción de avanzar automáticamente al siguiente fotograma
  const handleGuardarValidacion = useCallback(async (avanzarDespues = autoAvanzar) => {
    setGuardando(true);
    const ahora = Date.now();
    const inicio = inicioTiempoRef.current || ahora;
    const tiempoSegundos = Number(((ahora - inicio) / 1000).toFixed(1));

    if (modoValidacion === 'Poligono' && poligono.length >= 3) {
      calibrarDesdePoligonoExperto(poligono);
    }

    try {
      const payload = {
        frameId: identificadorFrame,
        imageUrl: `/dataset/${secuenciaActiva}/${identificadorFrame}.png`,
        tipoValidacion: modoValidacion,
        aprobadoBinario: modoValidacion === 'Binaria',
        poligonoPreEtiquetado: poligonoIA,
        poligono,
        validadorId: localStorage.getItem('expertId') || 'investigador_cidesi',
        tempMaxima: telemetriaPool.adMax,
        tempPromedio: telemetriaPool.adPromedio,
        incertidumbreAlgoritmo: telemetriaPool.incertidumbre,
        iouSimilitud: iouActual,
        tiempoValidacionSeg: tiempoSegundos,
        umbralRadiometrico: umbralIsotermico,
        direccionSoldadura,
        material,
        numeroCordones: cordones
      };

      await axios.post(API_URL, payload);
      setEstadoBD('Revisado');
      setModificadoSinGuardar(false);
      setMensajeEstado(`Guardado #${frameActual} (${tiempoSegundos}s | IoU: ${iouActual}%)`);

      if (avanzarDespues && frameActual < totalFrames) {
        irAFotograma(frameActual + 1);
      }
    } catch {
      setMensajeEstado('Error de conexión con Backend (Puerto 3000)');
    } finally {
      setGuardando(false);
    }
  }, [
    autoAvanzar, modoValidacion, poligono, poligonoIA, identificadorFrame,
    secuenciaActiva, telemetriaPool, iouActual, umbralIsotermico,
    direccionSoldadura, material, cordones, frameActual, totalFrames, irAFotograma
  ]);

  // Si el usuario modificó el polígono y presiona Siguiente o Anterior sin haber guardado,
  // auto-guardamos sus cambios primero para que nunca pierda su trabajo
  const handleNavegarSeguro = useCallback(async (direccion) => {
    if (modificadoSinGuardar && poligono.length >= 3) {
      await handleGuardarValidacion(false);
    }
    irAFotograma(frameActual + direccion);
  }, [modificadoSinGuardar, poligono.length, handleGuardarValidacion, irAFotograma, frameActual]);

  // Atajos de teclado ergonómicos para sesión de laboratorio (←, →, Espacio / Enter)
  useEffect(() => {
    const manejarTeclado = (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNavegarSeguro(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleNavegarSeguro(-1);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleGuardarValidacion(true);
      }
    };

    window.addEventListener('keydown', manejarTeclado);
    return () => window.removeEventListener('keydown', manejarTeclado);
  }, [handleNavegarSeguro, handleGuardarValidacion]);

  const handleAbrirMetricasHITL = async () => {
    try {
      const res = await axios.get(`${API_URL}?secuencia=${secuenciaActiva}`);
      const docs = res.data || [];
      if (docs.length > 0) {
        const total = docs.length;
        const sumaTiempo = docs.reduce((acc, d) => acc + (d.metadatos?.tiempoValidacionSeg || 2.5), 0);
        const sumaIoU = docs.reduce((acc, d) => acc + (d.metadatos?.iouSimilitud ?? 100), 0);
        const confirmaciones = docs.filter((d) => d.tipoValidacion === 'Binaria').length;

        setResumenMetricas({
          totalValidados: total,
          tiempoPromedioSeg: Number((sumaTiempo / total).toFixed(2)),
          iouPromedio: Number((sumaIoU / total).toFixed(1)),
          tasaConfirmacionDirecta: Number(((confirmaciones / total) * 100).toFixed(1)),
          tasaCorreccionHumana: Number((((total - confirmaciones) / total) * 100).toFixed(1))
        });
      }
    } catch {
      // Mantiene métricas locales
    }
    setMostrarMetricas(true);
  };

  const handleDescargarMascaraBinaria = () => {
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = 640;
    maskCanvas.height = 512;
    const mCtx = maskCanvas.getContext('2d');

    mCtx.fillStyle = '#000000';
    mCtx.fillRect(0, 0, 640, 512);

    if (poligono.length >= 3) {
      mCtx.beginPath();
      mCtx.moveTo(poligono[0].x, poligono[0].y);
      for (let i = 1; i < poligono.length; i++) {
        mCtx.lineTo(poligono[i].x, poligono[i].y);
      }
      mCtx.closePath();
      mCtx.fillStyle = '#FFFFFF';
      mCtx.fill();
    }

    const url = maskCanvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `MASK_${identificadorFrame}.png`;
    a.click();
  };

  const handleExportarCOCO = async () => {
    try {
      const res = await axios.get(`${API_URL}?secuencia=${secuenciaActiva}`);
      const registros = res.data;

      const listaExportar = registros.length > 0 ? registros : [{
        frameId: identificadorFrame,
        poligonoPreEtiquetado: poligonoIA,
        poligono,
        tipoValidacion: modoValidacion,
        metadatos: {
          areaPixeles: geometria.area,
          perimetroPixeles: geometria.perimetro,
          tempMaxima: telemetriaPool.adMax,
          tempPromedio: telemetriaPool.adPromedio,
          iouSimilitud: iouActual,
          direccionSoldadura,
          material
        }
      }];

      const cocoDataset = {
        info: {
          description: `CIDESI - Dataset Termográfico DED-LB (${secuenciaActiva})`,
          version: '1.0',
          year: 2026,
          contributor: localStorage.getItem('expertEmail') || 'Investigador CIDESI',
          total_validated_frames: listaExportar.length
        },
        images: listaExportar.map((item, idx) => ({
          id: idx + 1,
          file_name: `${item.frameId}.png`,
          width: 640,
          height: 512,
          flir_metadata: {
            camera_model: 'FLIR A6751sc',
            ad_bits: 14,
            fps: 127,
            emissivity: 0.92,
            max_counts: item.metadatos?.tempMaxima || telemetriaPool.adMax,
            mean_counts: item.metadatos?.tempPromedio || telemetriaPool.adPromedio,
            welding_direction: item.metadatos?.direccionSoldadura || direccionSoldadura,
            material: item.metadatos?.material || material
          }
        })),
        annotations: listaExportar.map((item, idx) => ({
          id: idx + 1,
          image_id: idx + 1,
          category_id: 1,
          segmentation: [item.poligono.flatMap((p) => [p.x, p.y])],
          ai_pre_segmentation: [item.poligonoPreEtiquetado?.flatMap((p) => [p.x, p.y]) || []],
          area: item.metadatos?.areaPixeles ?? geometria.area,
          perimeter: item.metadatos?.perimetroPixeles ?? geometria.perimetro,
          iou_agreement: item.metadatos?.iouSimilitud ?? 100,
          validation_time_sec: item.metadatos?.tiempoValidacionSeg ?? 0,
          iscrowd: 0,
          validation_mode: item.tipoValidacion
        })),
        categories: [{ id: 1, name: 'molten_pool', supercategory: 'welding_thermal' }]
      };

      const blob = new Blob([JSON.stringify(cocoDataset, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `COCO_${secuenciaActiva.replace('.ats', '')}_Dataset.json`;
      a.click();
      setMensajeEstado(`Exportados ${listaExportar.length} registros en formato COCO`);
    } catch {
      setMensajeEstado('Error al exportar dataset');
    }
  };

  const handleCerrarSesion = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('expertId');
    localStorage.removeItem('expertEmail');
    navigate('/login');
  };

  if (!isAuthorized) return null;

  return (
    <div
      translate="no"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: 'var(--bg-app)',
        color: 'var(--text-primary)',
        overflow: 'hidden'
      }}
    >
      {/* BARRA SUPERIOR */}
      <header style={{
        height: '52px',
        backgroundColor: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <span style={{ fontSize: '13px', fontWeight: '700', letterSpacing: '0.04em', color: 'var(--text-primary)' }}>
            CIDESI
          </span>
          <span style={{ color: 'var(--border-color)' }}>/</span>
          <span style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text-secondary)' }}>
            Estación de Análisis Termográfico HITL
          </span>
          <select
            value={secuenciaActiva}
            onChange={(e) => setSecuenciaActiva(e.target.value)}
            className="input-field"
            style={{ width: 'auto', height: '30px', fontSize: '12px', marginLeft: '8px' }}
          >
            <option value="RC1.ats">RC1.ats (5.05 GB)</option>
            <option value="RC2.ats">RC2.ats (4.66 GB)</option>
            <option value="RC3.ats">RC3.ats (4.43 GB)</option>
            <option value="RC4.ats">RC4.ats (4.52 GB)</option>
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label className="btn btn-outline" title="Seleccione múltiples fotogramas exportados de FLIR (.png/.jpg)">
            <svg className="icon-svg" viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>Cargar Lote ({loteFotogramas.length || 0})</span>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={handleSubirLoteImagenes}
              style={{ display: 'none' }}
            />
          </label>

          <button onClick={handleAbrirMetricasHITL} className="btn btn-outline">
            <svg className="icon-svg" viewBox="0 0 24 24">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            <span>Métricas HITL</span>
          </button>

          <button onClick={handleDescargarMascaraBinaria} className="btn btn-outline">
            <svg className="icon-svg" viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <span>Máscara PNG</span>
          </button>

          <button onClick={handleExportarCOCO} className="btn btn-outline">
            <svg className="icon-svg" viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Exportar COCO</span>
          </button>

          <button onClick={toggleTheme} className="btn btn-outline" title="Alternar Modo Claro / Oscuro">
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
          </button>

          <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

          <button onClick={handleCerrarSesion} className="btn btn-ghost">
            <svg className="icon-svg" viewBox="0 0 24 24">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>Salir</span>
          </button>
        </div>
      </header>

      {/* CUERPO PRINCIPAL */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        
        {/* PANEL IZQUIERDO */}
        <aside style={{
          width: '235px',
          backgroundColor: 'var(--bg-surface)',
          borderRight: '1px solid var(--border-color)',
          padding: '20px 16px',
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
          flexShrink: 0
        }}>
          <div className="panel-section">
            <div className="section-header">
              <h2 className="section-title">Cálculos Automáticos (IA)</h2>
            </div>
            <div className="data-list">
              <div className="data-row">
                <span className="data-label">AD Máximo (Piscina)</span>
                <span className="data-value">{telemetriaPool.adMax}</span>
              </div>
              <div className="data-row">
                <span className="data-label">AD Promedio</span>
                <span className="data-value">{telemetriaPool.adPromedio}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Centroide Térmico</span>
                <span className="data-value">({telemetriaPool.centroideX}, {telemetriaPool.centroideY})</span>
              </div>
              <div className="data-row">
                <span className="data-label">Área Piscina</span>
                <span className="data-value">{geometria.area} px²</span>
              </div>
              <div className="data-row">
                <span className="data-label">Perímetro</span>
                <span className="data-value">{geometria.perimetro} px</span>
              </div>
              <div className="data-row">
                <span className="data-label">Similitud IA (IoU)</span>
                <span className="data-value">{iouActual}%</span>
              </div>
            </div>
          </div>

          <div className="panel-section">
            <div className="section-header">
              <h2 className="section-title">Parámetros Radiométricos</h2>
            </div>
            <div className="data-list">
              <div className="data-row">
                <span className="data-label">Cámara</span>
                <span className="data-value">A6751sc</span>
              </div>
              <div className="data-row">
                <span className="data-label">Resolución</span>
                <span className="data-value">640×512</span>
              </div>
              <div className="data-row">
                <span className="data-label">Emisividad</span>
                <span className="data-value">0.92</span>
              </div>
              <div className="data-row">
                <span className="data-label">Distancia</span>
                <span className="data-value">1.00 m</span>
              </div>
            </div>
          </div>

          <div className="panel-section">
            <div className="section-header">
              <h2 className="section-title">Parámetros de Proceso</h2>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Material Base
                </label>
                <input
                  value={material}
                  onChange={(e) => setMaterial(e.target.value)}
                  className="input-field"
                  style={{ height: '30px', fontSize: '12px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Dirección de Soldadura
                </label>
                <select
                  value={direccionSoldadura}
                  onChange={(e) => setDireccionSoldadura(e.target.value)}
                  className="input-field"
                  style={{ height: '30px', fontSize: '12px' }}
                >
                  <option>Derecha a Izquierda</option>
                  <option>Izquierda a Derecha</option>
                  <option>Vertical Ascendente</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Número de Cordones
                </label>
                <input
                  type="number"
                  min="1"
                  value={cordones}
                  onChange={(e) => setCordones(Number(e.target.value))}
                  className="input-field"
                  style={{ height: '30px', fontSize: '12px' }}
                />
              </div>
            </div>
          </div>
        </aside>

        {/* VISOR CENTRAL */}
        <main style={{
          flex: 1,
          backgroundColor: 'var(--bg-canvas-viewport)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px',
          overflow: 'auto'
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              padding: '6px 12px',
              fontSize: '12px',
              boxShadow: 'var(--shadow-sm)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Fotograma <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{frameActual}</strong> / {totalFrames}
                  {fotogramaActivo && (
                    <span style={{ marginLeft: '6px', color: 'var(--text-muted)', fontSize: '11px' }}>
                      ({fotogramaActivo.nombreArchivo})
                    </span>
                  )}
                </span>
                <span style={{ color: 'var(--border-color)' }}>|</span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Incertidumbre IA: <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{telemetriaPool.incertidumbre}%</strong>
                </span>
                <span style={{ color: 'var(--border-color)' }}>|</span>
                <span style={{
                  fontSize: '11px',
                  fontWeight: '600',
                  color: modificadoSinGuardar
                    ? '#f59e0b'
                    : estadoBD === 'Revisado'
                    ? 'var(--accent-primary)'
                    : '#10b981'
                }}>
                  {modificadoSinGuardar
                    ? 'Editando (Sin guardar)'
                    : estadoBD === 'Revisado'
                    ? 'Validado en Atlas'
                    : 'Pre-etiquetado por IA'}
                </span>
              </div>

              <div style={{
                fontFamily: 'JetBrains Mono, Consolas, monospace',
                fontSize: '11px',
                color: 'var(--text-primary)',
                backgroundColor: 'var(--bg-subtle)',
                padding: '2px 8px',
                borderRadius: '4px',
                border: '1px solid var(--border-color)'
              }}>
                X: {cursorPos.x} &nbsp; Y: {cursorPos.y} &nbsp; AD: {cursorPos.counts}
              </div>
            </div>

            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              backgroundColor: 'var(--bg-surface)',
              padding: '10px',
              borderRadius: '6px',
              border: '1px solid var(--border-color)',
              boxShadow: 'var(--shadow-sm)'
            }}>
              <canvas
                ref={canvasRef}
                width={640}
                height={512}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onContextMenu={handleContextMenu}
                style={{
                  display: 'block',
                  border: '1px solid var(--border-color)',
                  cursor: modoValidacion === 'Poligono' ? 'crosshair' : 'pointer'
                }}
              />

              <div style={{
                height: '512px',
                width: '44px',
                padding: '4px 0',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: '10px',
                fontFamily: 'JetBrains Mono, Consolas, monospace',
                color: 'var(--text-secondary)'
              }}>
                <span style={{ fontWeight: '600', color: 'var(--text-primary)' }}>7082</span>
                <span>4715</span>
                <div style={{
                  flex: 1,
                  width: '12px',
                  margin: '6px 0',
                  background: 'linear-gradient(to bottom, #ffffff 0%, #a1a1aa 45%, #27272a 80%, #09090b 100%)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '2px'
                }} />
                <span>1415</span>
                <span>1017</span>
              </div>
            </div>

            {/* BARRA UNIFICADA DE TRANSPORTE Y VALIDACIÓN RÁPIDA (ANTERIOR / SLIDER / SIGUIENTE / GUARDAR) */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              padding: '8px 12px',
              boxShadow: 'var(--shadow-sm)'
            }}>
              <button
                type="button"
                onClick={() => handleNavegarSeguro(-1)}
                disabled={frameActual <= 1}
                className="btn btn-outline"
                style={{ height: '30px', padding: '0 10px', fontSize: '11px' }}
                title="Fotograma anterior (Flecha Izquierda ←)"
              >
                <svg className="icon-svg" viewBox="0 0 24 24">
                  <polygon points="19 20 9 12 19 4 19 20" />
                  <line x1="5" y1="19" x2="5" y2="5" />
                </svg>
                <span>Anterior</span>
              </button>

              <input
                type="range"
                min="1"
                max={totalFrames}
                value={frameActual}
                onChange={(e) => irAFotograma(Number(e.target.value))}
                style={{ flex: 1, accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
              />

              <input
                type="number"
                min="1"
                max={totalFrames}
                value={frameActual}
                onChange={(e) => irAFotograma(Number(e.target.value))}
                className="input-field"
                style={{ width: '64px', height: '30px', fontSize: '11px', textAlign: 'center', fontFamily: 'monospace' }}
                title="Ir directamente al número de fotograma"
              />

              <button
                type="button"
                onClick={() => handleNavegarSeguro(1)}
                disabled={frameActual >= totalFrames}
                className="btn btn-outline"
                style={{ height: '30px', padding: '0 10px', fontSize: '11px' }}
                title="Siguiente fotograma (Flecha Derecha →)"
              >
                <span>Siguiente</span>
                <svg className="icon-svg" viewBox="0 0 24 24">
                  <polygon points="5 4 15 12 5 20 5 4" />
                  <line x1="19" y1="5" x2="19" y2="19" />
                </svg>
              </button>

              {/* Botón directo de 1 solo clic junto a los controles de reproducción */}
              <button
                type="button"
                onClick={() => handleGuardarValidacion(true)}
                disabled={guardando}
                className="btn btn-primary"
                style={{ height: '30px', padding: '0 14px', fontSize: '11px' }}
                title="Guardar en Atlas y pasar al siguiente fotograma (Tecla Espacio o Enter)"
              >
                <span>{guardando ? 'Guardando...' : 'Guardar y Siguiente'}</span>
                <svg className="icon-svg" viewBox="0 0 24 24">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          </div>
        </main>

        {/* PANEL DERECHO */}
        <aside style={{
          width: '265px',
          backgroundColor: 'var(--bg-surface)',
          borderLeft: '1px solid var(--border-color)',
          padding: '20px 16px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          flexShrink: 0
        }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            
            <div className="panel-section">
              <div className="section-header">
                <h2 className="section-title">Pre-Segmentación IA</h2>
                <div className="info-tooltip">
                  <svg className="icon-svg" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                  <div className="tooltip-content">
                    Atajos rápidos: [Espacio/Enter] Guardar y Avanzar | [← / →] Cambiar fotograma con auto-guardado.
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)' }}>
                  <span>Corte Isotérmico (Liquidus)</span>
                  <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                    {Math.round(1017 + (umbralIsotermico / 255) * (7082 - 1017))} AD
                  </span>
                </div>
                <input
                  type="range"
                  min="150"
                  max="248"
                  value={umbralIsotermico}
                  onChange={(e) => {
                    const nuevoUmbral = Number(e.target.value);
                    setUmbralIsotermico(nuevoUmbral);
                    ejecutarPreSegmentacionIA(nuevoUmbral, imgElement, recorteEstela);
                  }}
                  style={{ width: '100%', accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                />

                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer', marginTop: '2px' }}>
                  <input
                    type="checkbox"
                    checked={recorteEstela}
                    onChange={(e) => {
                      const val = e.target.checked;
                      setRecorteEstela(val);
                      ejecutarPreSegmentacionIA(umbralIsotermico, imgElement, val);
                    }}
                  />
                  Suprimir estela de enfriamiento
                </label>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '2px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={mostrarGuiaIA}
                      onChange={(e) => setMostrarGuiaIA(e.target.checked)}
                    />
                    Mostrar trazo IA
                  </label>
                  <button
                    type="button"
                    onClick={() => ejecutarPreSegmentacionIA(umbralIsotermico, imgElement, recorteEstela)}
                    className="btn btn-outline"
                    style={{ height: '24px', padding: '0 8px', fontSize: '11px' }}
                  >
                    Recalcular
                  </button>
                </div>

                {plantillaExperto && (
                  <button
                    type="button"
                    onClick={handleAplicarPlantillaExperto}
                    className="btn btn-outline"
                    style={{ width: '100%', marginTop: '4px', height: '28px', fontSize: '11px' }}
                  >
                    Propagar contorno experto anterior
                  </button>
                )}
              </div>
            </div>

            <div className="panel-section">
              <div className="section-header">
                <h2 className="section-title">Dictamen del Experto</h2>
              </div>

              <div className="segmented-control" style={{ marginBottom: '12px' }}>
                <button
                  type="button"
                  onClick={() => setModoValidacion('Binaria')}
                  className={`segment-btn ${modoValidacion === 'Binaria' ? 'active' : ''}`}
                >
                  <svg className="icon-svg" viewBox="0 0 24 24">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Confirmar IA</span>
                </button>
                <button
                  type="button"
                  onClick={() => setModoValidacion('Poligono')}
                  className={`segment-btn ${modoValidacion === 'Poligono' ? 'active' : ''}`}
                >
                  <svg className="icon-svg" viewBox="0 0 24 24">
                    <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2" />
                  </svg>
                  <span>Corregir</span>
                </button>
              </div>

              {modoValidacion === 'Poligono' && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      setPoligono((prev) => prev.slice(0, -1));
                      setModificadoSinGuardar(true);
                    }}
                    className="btn btn-outline"
                    style={{ flex: 1 }}
                  >
                    <svg className="icon-svg" viewBox="0 0 24 24">
                      <path d="M3 7v6h6" />
                      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
                    </svg>
                    <span>Deshacer</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPoligono([]);
                      setModificadoSinGuardar(true);
                    }}
                    className="btn btn-outline"
                    style={{ flex: 1 }}
                  >
                    <svg className="icon-svg" viewBox="0 0 24 24">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                    <span>Limpiar</span>
                  </button>
                </div>
              )}
            </div>

            <div className="panel-section">
              <details open>
                <summary style={{
                  fontSize: '11px',
                  fontWeight: '600',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  marginBottom: '10px',
                  userSelect: 'none'
                }}>
                  Coordenadas COCO ({poligono.length})
                </summary>

                <div style={{
                  maxHeight: '140px',
                  overflowY: 'auto',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px'
                }}>
                  {poligono.length === 0 ? (
                    <div style={{ padding: '12px', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
                      Sin vértices registrados
                    </div>
                  ) : (
                    <table className="coord-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>X (px)</th>
                          <th>Y (px)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {poligono.map((pt, i) => (
                          <tr key={i}>
                            <td style={{ color: 'var(--text-muted)' }}>V{i + 1}</td>
                            <td>{pt.x}</td>
                            <td>{pt.y}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </details>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoAvanzar}
                onChange={(e) => setAutoAvanzar(e.target.checked)}
              />
              Auto-avanzar al siguiente fotograma
            </label>

            {mensajeEstado && (
              <div style={{
                padding: '6px 10px',
                backgroundColor: 'var(--bg-subtle)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                fontSize: '11px',
                color: 'var(--text-secondary)',
                textAlign: 'center'
              }}>
                {mensajeEstado}
              </div>
            )}

            <button
              type="button"
              onClick={() => handleGuardarValidacion(autoAvanzar)}
              disabled={guardando}
              className="btn btn-primary"
              style={{ width: '100%', height: '38px', fontSize: '13px' }}
            >
              <svg className="icon-svg" viewBox="0 0 24 24">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              <span>
                {guardando
                  ? 'Sincronizando...'
                  : autoAvanzar
                  ? 'Guardar y Avanzar'
                  : 'Guardar Validación'}
              </span>
            </button>
          </div>
        </aside>
      </div>

      {/* MODAL DE MÉTRICAS DE DESEMPEÑO HITL */}
      {mostrarMetricas && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100
        }}>
          <div style={{
            width: '480px',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            padding: '24px',
            boxShadow: 'var(--shadow-sm)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--accent-primary)', textTransform: 'uppercase' }}>
                  Evaluación Experimental • {secuenciaActiva}
                </span>
                <h3 style={{ margin: '4px 0 0 0', fontSize: '16px', color: 'var(--text-primary)' }}>
                  Indicadores de Desempeño Human-in-the-Loop
                </h3>
              </div>
              <button onClick={() => setMostrarMetricas(false)} className="btn btn-outline" style={{ height: '28px', padding: '0 8px' }}>
                Cerrar
              </button>
            </div>

            <div className="data-list" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
              <div className="data-row">
                <span className="data-label">Fotogramas Validados en MongoDB</span>
                <span className="data-value">{resumenMetricas.totalValidados} frames</span>
              </div>
              <div className="data-row">
                <span className="data-label">Latencia Media de Validación</span>
                <span className="data-value">{resumenMetricas.tiempoPromedioSeg} seg / frame</span>
              </div>
              <div className="data-row">
                <span className="data-label">Consistencia Algoritmo vs. Experto (IoU)</span>
                <span className="data-value">{resumenMetricas.iouPromedio}%</span>
              </div>
              <div className="data-row">
                <span className="data-label">Tasa de Aprobación Directa (Binaria)</span>
                <span className="data-value">{resumenMetricas.tasaConfirmacionDirecta}%</span>
              </div>
              <div className="data-row">
                <span className="data-label">Tasa de Refinamiento Poligonal</span>
                <span className="data-value">{resumenMetricas.tasaCorreccionHumana}%</span>
              </div>
            </div>

            <div style={{ marginTop: '18px', fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.5' }}>
              Métricas calculadas en tiempo real a partir de las colecciones documentales de MongoDB Atlas para la evaluación cuantitativa del flujo HITL.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}