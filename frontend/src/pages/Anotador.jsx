import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import '../styles/scientific-ui.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const API_URL = `${BASE_URL}/api/annotations`;
const YOLO_CARLOS_API = import.meta.env.VITE_YOLO_URL || 'http://localhost:8000/api/yolo/predict';

const FLIR_WIDTH = 640;
const FLIR_HEIGHT = 512;
const FLIR_PIXELS = FLIR_WIDTH * FLIR_HEIGHT; // 327,680 píxeles
const FLIR_FRAME_BYTES = FLIR_PIXELS * 2; // 655,360 bytes

const METADATOS_FLIR_BASE = {
  cameraModel: 'FLIR A6751sc',
  resolution: '640×512',
  adBits: 14,
  fps: 127,
  emissivity: 0.92,
  distanceMeters: 1.0,
  reflectedTempC: 20.0,
  relativeHumidity: 30.0
};

// Mapa de color científico (LUT) para visualización termográfica sin alterar los datos crudos
function obtenerColorTermicoRGB(norm, paleta) {
  const v = Math.max(0, Math.min(255, norm));

  if (paleta === 'grayscale') {
    return [v, v, v];
  }

  if (paleta === 'redhot') {
    if (v < 70) {
      const t = v / 70;
      return [Math.round(t * 140), Math.round(t * 8), Math.round(t * 12)];
    }
    if (v < 165) {
      const t = (v - 70) / 95;
      return [Math.round(140 + t * 115), Math.round(8 + t * 45), Math.round(12 + t * 15)];
    }
    if (v < 225) {
      const t = (v - 165) / 60;
      return [255, Math.round(53 + t * 145), Math.round(27 + t * 70)];
    }
    const t = (v - 225) / 30;
    return [255, Math.round(198 + t * 57), Math.round(97 + t * 158)];
  }

  // Por defecto: 'ironbow' (Rojizo / Hierro FLIR)
  if (v < 45) {
    const t = v / 45;
    return [Math.round(t * 75), Math.round(t * 6), Math.round(t * 35)];
  }
  if (v < 125) {
    const t = (v - 45) / 80;
    return [Math.round(75 + t * 165), Math.round(6 + t * 34), Math.round(35 - t * 20)];
  }
  if (v < 195) {
    const t = (v - 125) / 70;
    return [Math.round(240 + t * 15), Math.round(40 + t * 135), Math.round(15 + t * 10)];
  }
  if (v < 235) {
    const t = (v - 195) / 40;
    return [255, Math.round(175 + t * 65), Math.round(25 + t * 135)];
  }
  const t = (v - 235) / 20;
  return [255, Math.round(240 + t * 15), Math.round(160 + t * 95)];
}

export default function Anotador() {
  const navigate = useNavigate();
  const [isAuthorized] = useState(!!localStorage.getItem('token'));
  const canvasRef = useRef(null);
  const inicioTiempoRef = useRef(null);
  const ultimoCentroExpertoRef = useRef(null);

  const registroSecuenciaRef = useRef({});
  const matriz14BitActualRef = useRef(null);
  const cacheFramesMongoRef = useRef({});

  useEffect(() => {
    inicioTiempoRef.current = Date.now();
  }, []);

  const [theme, setTheme] = useState(localStorage.getItem('ui-theme') || 'light');
  const [paletaTermica, setPaletaTermica] = useState(
    localStorage.getItem('hitl-paleta') || 'ironbow'
  );
  const [secuenciaActiva, setSecuenciaActiva] = useState(
    localStorage.getItem('hitl-secuencia') || 'RC1.ats'
  );

  const [archivoAtsCrudo, setArchivoAtsCrudo] = useState(null);
  const [loteFotogramas, setLoteFotogramas] = useState([]);

  const [indiceLote, setIndiceLote] = useState(0);
  const [frameActual, setFrameActual] = useState(1);
  const [totalFrames, setTotalFrames] = useState(100);

  // Estados de Zoom Inteligente y Filtro de Puntos Muertos
  const [zoomLevel, setZoomLevel] = useState(3.5);
  const [zoomCenter, setZoomCenter] = useState({ x: 260, y: 210 });
  const [autoSeguirPiscina, setAutoSeguirPiscina] = useState(true);
  const [omitirPuntosMuertos, setOmitirPuntosMuertos] = useState(true);
  const [esPuntoMuerto, setEsPuntoMuerto] = useState(false);
  const [buscandoFrameActivo, setBuscandoFrameActivo] = useState(false);
  const [pasoMuestreoLote, setPasoMuestreoLote] = useState(25);

  const [ajusteFilaAts, setAjusteFilaAts] = useState(0);
  const [ajusteColAts, setAjusteColAts] = useState(0);

  const [motorPreSegmentacion, setMotorPreSegmentacion] = useState('YOLO_CARLOS');
  const [procesandoLoteMasivo, setProcesandoLoteMasivo] = useState(false);
  const [progresoLote, setProgresoLote] = useState(0);
  const [totalFramesEnRegistro, setTotalFramesEnRegistro] = useState(0);

  const fotogramaActivo = loteFotogramas.length > 0 ? loteFotogramas[indiceLote] : null;
  const imgElement = fotogramaActivo ? fotogramaActivo.imgElement : null;
  const identificadorFrame = archivoAtsCrudo
    ? `${secuenciaActiva}_frame_${frameActual}`
    : fotogramaActivo
    ? `${secuenciaActiva}_${fotogramaActivo.nombreArchivo.replace(/\.[^/.]+$/, '')}`
    : `${secuenciaActiva}_frame_${frameActual}`;

  const timestampMsActual = Math.round(((frameActual - 1) / METADATOS_FLIR_BASE.fps) * 1000);

  const [umbralIsotermico, setUmbralIsotermico] = useState(215);
  const [recorteEstela, setRecorteEstela] = useState(true);
  const [plantillaExperto, setPlantillaExperto] = useState(null);

  const [autoAvanzar, setAutoAvanzar] = useState(true);
  const [modificadoSinGuardar, setModificadoSinGuardar] = useState(false);

  const [poligonoIA, setPoligonoIA] = useState([]);
  const [poligono, setPoligono] = useState([]);
  const [mostrarGuiaIA, setMostrarGuiaIA] = useState(true);

  const [telemetriaPool, setTelemetriaPool] = useState({
    adMax: 7082,
    adPromedio: 6150,
    adMin: 1017,
    deltaTermico: 4500,
    centroideX: 260,
    centroideY: 210,
    incertidumbre: 9.4
  });

  const [modoValidacion, setModoValidacion] = useState('Binaria');
  const [verticeArrastrado, setVerticeArrastrado] = useState(null);

  const [estadoBD, setEstadoBD] = useState('Pendiente');
  const [cursorPos, setCursorPos] = useState({ x: 260, y: 210, counts: 6820 });
  const [guardando, setGuardando] = useState(false);
  const [mensajeEstado, setMensajeEstado] = useState('');

  const [mostrarMetricas, setMostrarMetricas] = useState(false);
  const [resumenMetricas, setResumenMetricas] = useState({
    totalValidados: 0,
    totalPreSegmentados: 0,
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
    localStorage.setItem('hitl-paleta', paletaTermica);
  }, [paletaTermica]);

  useEffect(() => {
    if (!isAuthorized) {
      navigate('/login', { replace: true });
    }
  }, [isAuthorized, navigate]);

  const obtenerVentanaZoom = useCallback(() => {
    const viewW = FLIR_WIDTH / zoomLevel;
    const viewH = FLIR_HEIGHT / zoomLevel;
    const vx = Math.max(0, Math.min(FLIR_WIDTH - viewW, zoomCenter.x - viewW / 2));
    const vy = Math.max(0, Math.min(FLIR_HEIGHT - viewH, zoomCenter.y - viewH / 2));
    return { vx, vy, viewW, viewH };
  }, [zoomLevel, zoomCenter]);

  const calcularGeometria = useCallback((puntos) => {
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
  }, []);

  const registrarFrameEnCatalogoMaestro = useCallback((frameIdKey, datosFrame) => {
    if (!datosFrame.poligono || datosFrame.poligono.length < 3) return;
    const existente = registroSecuenciaRef.current[frameIdKey];
    if (existente?.validadoPorExperto && !datosFrame.validadoPorExperto) {
      return;
    }
    const geo = calcularGeometria(datosFrame.poligono);
    registroSecuenciaRef.current[frameIdKey] = {
      frameId: frameIdKey,
      frameNumber: datosFrame.frameNumber || frameActual,
      fileName: `${frameIdKey}.png`,
      poligonoIA: datosFrame.poligonoIA || datosFrame.poligono || [],
      poligono: datosFrame.poligono || [],
      validadoPorExperto: Boolean(datosFrame.validadoPorExperto),
      tipoValidacion: datosFrame.tipoValidacion || 'PreSegmentacion_IA',
      algoritmoOrigen: datosFrame.algoritmoOrigen || motorPreSegmentacion,
      metadatos: {
        ...METADATOS_FLIR_BASE,
        timestampMs: Math.round((((datosFrame.frameNumber || frameActual) - 1) / METADATOS_FLIR_BASE.fps) * 1000),
        tempMaxima: datosFrame.adMax || 7082,
        tempPromedio: datosFrame.adPromedio || 6100,
        tempMinima: datosFrame.adMin || 1017,
        centroideX: datosFrame.centroideX || 260,
        centroideY: datosFrame.centroideY || 210,
        areaPixeles: geo.area,
        perimetroPixeles: geo.perimetro,
        incertidumbreAlgoritmo: datosFrame.incertidumbre || 10.5,
        iouSimilitud: datosFrame.iouSimilitud ?? 100,
        tiempoValidacionSeg: datosFrame.tiempoValidacionSeg || 0,
        direccionSoldadura,
        material,
        numeroCordones: cordones
      }
    };
    setTotalFramesEnRegistro(Object.keys(registroSecuenciaRef.current).length);
  }, [calcularGeometria, frameActual, motorPreSegmentacion, direccionSoldadura, material, cordones]);

  // =========================================================================
  // 1. DECODIFICADOR .ATS SIN ARTEFACTOS DE BORDE Y CON DETECTOR DE PUNTOS MUERTOS
  // =========================================================================
  const decodificarFrameDesdeATS = useCallback(async (
    fileAts,
    numeroFrame,
    shiftFilasManual = ajusteFilaAts,
    shiftColsManual = ajusteColAts
  ) => {
    if (!fileAts) return null;

    const strideEstimado = 656638;
    const ventanaLecturaBytes = FLIR_FRAME_BYTES * 2 + 16384;
    const posAprox = Math.max(0, (numeroFrame - 1) * strideEstimado);
    const inicioSlice = Math.max(0, Math.min(fileAts.size - ventanaLecturaBytes, posAprox));

    const sliceBlob = fileAts.slice(inicioSlice, Math.min(fileAts.size, inicioSlice + ventanaLecturaBytes));
    const buffer = await sliceBlob.arrayBuffer();
    if (buffer.byteLength < FLIR_FRAME_BYTES) return null;

    const dv = new DataView(buffer);

    const candidatos = [
      { byteShift: 0, littleEndian: true },
      { byteShift: 1, littleEndian: true },
      { byteShift: 0, littleEndian: false },
      { byteShift: 1, littleEndian: false }
    ];

    let mejorConfig = candidatos[0];
    let menorRugosidad = Infinity;

    for (const cand of candidatos) {
      let sumaSaltos = 0;
      let fueraDeRango = 0;
      const offsetMuestra = 64000;

      for (let i = 0; i < 4000; i++) {
        const bPos1 = offsetMuestra + i * 2 + cand.byteShift;
        const bPos2 = bPos1 + 2;
        if (bPos2 + 2 >= buffer.byteLength) break;

        const v1 = dv.getUint16(bPos1, cand.littleEndian) & 0x3FFF;
        const v2 = dv.getUint16(bPos2, cand.littleEndian) & 0x3FFF;

        sumaSaltos += Math.abs(v2 - v1);
        if (v1 < 800 || v1 > 9500) fueraDeRango += 250;
      }

      const puntaje = sumaSaltos + fueraDeRango;
      if (puntaje < menorRugosidad) {
        menorRugosidad = puntaje;
        mejorConfig = cand;
      }
    }

    const totalWords = Math.floor((buffer.byteLength - mejorConfig.byteShift) / 2);
    const words = new Uint16Array(totalWords);
    for (let i = 0; i < totalWords; i++) {
      words[i] = dv.getUint16(i * 2 + mejorConfig.byteShift, mejorConfig.littleEndian) & 0x3FFF;
    }

    const maxFilasBusqueda = Math.min(540, Math.floor((totalWords - FLIR_PIXELS) / FLIR_WIDTH));
    let filaMetaDetectada = 0;
    let maxAnomaliaFila = -1;

    for (let r = 0; r < maxFilasBusqueda; r++) {
      let anomalia = 0;
      const baseW = r * FLIR_WIDTH;
      for (let c = 0; c < FLIR_WIDTH; c += 2) {
        const val = words[baseW + c];
        const prevFilaVal = r > 0 ? words[baseW - FLIR_WIDTH + c] : val;
        if (val < 850 || val > 9200) anomalia += 800;
        anomalia += Math.abs(val - prevFilaVal);
      }
      if (anomalia > maxAnomaliaFila) {
        maxAnomaliaFila = anomalia;
        filaMetaDetectada = r;
      }
    }

    const filaInicioLimpia = Math.min(maxFilasBusqueda, filaMetaDetectada + 3);
    const basePostMeta = filaInicioLimpia * FLIR_WIDTH;
    let colSeamDetectada = 0;
    let maxSaltoColumna = -1;

    for (let c = 0; c < FLIR_WIDTH; c++) {
      let saltoCol = 0;
      const cPrev = (c - 1 + FLIR_WIDTH) % FLIR_WIDTH;
      for (let r = 20; r < 100; r++) {
        const idxActual = basePostMeta + r * FLIR_WIDTH + c;
        const idxPrev = basePostMeta + r * FLIR_WIDTH + cPrev;
        if (idxActual < totalWords && idxPrev < totalWords) {
          saltoCol += Math.abs(words[idxActual] - words[idxPrev]);
        }
      }
      if (saltoCol > maxSaltoColumna) {
        maxSaltoColumna = saltoCol;
        colSeamDetectada = c;
      }
    }

    let startWord =
      (filaInicioLimpia + shiftFilasManual) * FLIR_WIDTH +
      ((colSeamDetectada + shiftColsManual) % FLIR_WIDTH);

    startWord = Math.max(0, Math.min(totalWords - FLIR_PIXELS, startWord));

    const frameClean16 = new Uint16Array(FLIR_PIXELS);
    let minAD = 16383;
    let maxAD = 0;
    let sumaFondo = 0;
    let conteoFondo = 0;

    for (let y = 0; y < FLIR_HEIGHT; y++) {
      for (let x = 0; x < FLIR_WIDTH; x++) {
        const i = y * FLIR_WIDTH + x;
        let val = words[startWord + i];

        const enBordeMeta = y < 4 || y > 507 || x < 4 || x > 635;
        if (enBordeMeta || val < 850 || val > 8200) {
          val = i >= FLIR_WIDTH ? frameClean16[i - FLIR_WIDTH] : 1042;
        }

        frameClean16[i] = val;

        if (!enBordeMeta) {
          if (val < minAD) minAD = val;
          if (val > maxAD) maxAD = val;
          if (val < 1800) {
            sumaFondo += val;
            conteoFondo++;
          }
        }
      }
    }

    const mediaFondo = conteoFondo > 0 ? Math.round(sumaFondo / conteoFondo) : 1042;
    const deltaTermico = maxAD - mediaFondo;
    const frameSinLaserActivo = deltaTermico < 650 || maxAD < 1850;

    const minEfectivo = Math.max(minAD, Math.min(mediaFondo - 10, minAD + 25));
    const maxEfectivo = Math.max(minEfectivo + 350, maxAD);

    matriz14BitActualRef.current = {
      raw16: frameClean16,
      minAD: minEfectivo,
      maxAD: maxEfectivo,
      mediaFondo,
      deltaTermico,
      esPuntoMuerto: frameSinLaserActivo,
      timestampMs: Math.round(((numeroFrame - 1) / 127) * 1000)
    };

    setEsPuntoMuerto(frameSinLaserActivo);
    return matriz14BitActualRef.current;
  }, [ajusteFilaAts, ajusteColAts]);

  // Dibujar escena térmica nativa 1:1 (640x512)
  const dibujarFuenteTermicaNativa = useCallback((
    ctx,
    width,
    height,
    imagenExplicita = imgElement,
    forzarMonocromoIA = false
  ) => {
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, width, height);

    const paletaActiva = forzarMonocromoIA ? 'grayscale' : paletaTermica;

    if (archivoAtsCrudo && matriz14BitActualRef.current) {
      const { raw16, minAD, maxAD } = matriz14BitActualRef.current;
      const rango = Math.max(1, maxAD - minAD);
      const imgDataObj = ctx.createImageData(FLIR_WIDTH, FLIR_HEIGHT);
      const data = imgDataObj.data;

      for (let i = 0; i < FLIR_PIXELS; i++) {
        const adVal = raw16[i];
        const ratio = Math.max(0, Math.min(1, (adVal - minAD) / rango));
        const norm = Math.round(Math.pow(ratio, 0.92) * 255);
        const [r, g, b] = obtenerColorTermicoRGB(norm, paletaActiva);

        const pxIdx = i * 4;
        data[pxIdx] = r;
        data[pxIdx + 1] = g;
        data[pxIdx + 2] = b;
        data[pxIdx + 3] = 255;
      }
      ctx.putImageData(imgDataObj, 0, 0);
      return;
    }

    if (imagenExplicita) {
      ctx.drawImage(imagenExplicita, 0, 0, width, height);
      if (!forzarMonocromoIA && paletaActiva !== 'grayscale') {
        const imgDataObj = ctx.getImageData(0, 0, width, height);
        const data = imgDataObj.data;
        for (let i = 0; i < data.length; i += 4) {
          const lum = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
          const [r, g, b] = obtenerColorTermicoRGB(lum, paletaActiva);
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
        }
        ctx.putImageData(imgDataObj, 0, 0);
      }
      return;
    }

    const seed = loteFotogramas.length > 0 ? indiceLote + 1 : frameActual;
    const offsetX = Math.sin(seed * 0.45) * 35;
    const offsetY = Math.cos(seed * 0.35) * 18;
    const cx = Math.round(260 + offsetX);
    const cy = Math.round(210 + offsetY);

    const gradExterior = ctx.createRadialGradient(cx, cy, 5, cx, cy, 55);
    gradExterior.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradExterior.addColorStop(0.38, 'rgba(230, 230, 230, 0.9)');
    gradExterior.addColorStop(0.68, 'rgba(95, 95, 95, 0.35)');
    gradExterior.addColorStop(1, 'rgba(5, 5, 5, 0)');
    ctx.fillStyle = gradExterior;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 48, 22, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - 18, cy - 8, 36, 16);

    if (!forzarMonocromoIA && paletaActiva !== 'grayscale') {
      const imgDataObj = ctx.getImageData(0, 0, width, height);
      const data = imgDataObj.data;
      for (let i = 0; i < data.length; i += 4) {
        const lum = data[i];
        const [r, g, b] = obtenerColorTermicoRGB(lum, paletaActiva);
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
      ctx.putImageData(imgDataObj, 0, 0);
    }
  }, [archivoAtsCrudo, imgElement, paletaTermica, loteFotogramas.length, indiceLote, frameActual]);

  // =========================================================================
  // 2. CONECTOR PARA EL ALGORITMO YOLO DE CARLOS
  // =========================================================================
  const ejecutarAlgoritmoCarlosYOLO = useCallback(async (canvasOffscreen) => {
    try {
      const frameBase64 = canvasOffscreen.toDataURL('image/png');
      const response = await axios.post(
        YOLO_CARLOS_API,
        {
          frameId: identificadorFrame,
          secuencia: secuenciaActiva,
          frameNumber: frameActual,
          width: FLIR_WIDTH,
          height: FLIR_HEIGHT,
          imageBase64: frameBase64
        },
        { timeout: 1400 }
      );

      if (response.data && Array.isArray(response.data.polygon) && response.data.polygon.length >= 3) {
        const pts = response.data.polygon.map((p) => ({
          x: Math.round(Number(p.x ?? p[0])),
          y: Math.round(Number(p.y ?? p[1]))
        }));
        const cx = Math.round(pts.reduce((a, b) => a + b.x, 0) / pts.length);
        const cy = Math.round(pts.reduce((a, b) => a + b.y, 0) / pts.length);
        const conf = Number(response.data.confidence ?? 0.88);

        return {
          exito: true,
          origen: 'YOLO_CARLOS',
          vertices: pts,
          adMax: response.data.max_ad || 7082,
          adPromedio: response.data.mean_ad || 6350,
          adMin: response.data.min_ad || 1017,
          centroideX: cx,
          centroideY: cy,
          incertidumbre: Number(((1 - conf) * 100).toFixed(1))
        };
      }
    } catch {
      // Usa respaldo isotérmico local
    }
    return { exito: false };
  }, [identificadorFrame, secuenciaActiva, frameActual]);

  // =========================================================================
  // 3. MOTOR DE PRE-SEGMENTACIÓN CON DETECTOR DE PUNTOS MUERTOS
  // =========================================================================
  const ejecutarPreSegmentacionIA = useCallback(async (
    umbralCustom = umbralIsotermico,
    imagenTarget = imgElement,
    usarRecorteCola = recorteEstela,
    frameIdExplicito = identificadorFrame,
    numFrameExplicito = frameActual
  ) => {
    if (archivoAtsCrudo && matriz14BitActualRef.current?.esPuntoMuerto) {
      setPoligonoIA([]);
      setPoligono([]);
      setTelemetriaPool((prev) => ({
        ...prev,
        adMax: matriz14BitActualRef.current.maxAD,
        adPromedio: matriz14BitActualRef.current.mediaFondo,
        adMin: matriz14BitActualRef.current.minAD,
        deltaTermico: matriz14BitActualRef.current.deltaTermico,
        incertidumbre: 0
      }));
      return [];
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = FLIR_WIDTH;
    offscreen.height = FLIR_HEIGHT;
    const ctx = offscreen.getContext('2d');

    dibujarFuenteTermicaNativa(ctx, FLIR_WIDTH, FLIR_HEIGHT, imagenTarget, true);

    if (motorPreSegmentacion === 'YOLO_CARLOS') {
      const resultadoYolo = await ejecutarAlgoritmoCarlosYOLO(offscreen);
      if (resultadoYolo.exito) {
        setPoligonoIA(resultadoYolo.vertices);
        setPoligono(resultadoYolo.vertices);
        setTelemetriaPool({
          adMax: resultadoYolo.adMax,
          adPromedio: resultadoYolo.adPromedio,
          adMin: resultadoYolo.adMin,
          deltaTermico: resultadoYolo.adMax - resultadoYolo.adMin,
          centroideX: resultadoYolo.centroideX,
          centroideY: resultadoYolo.centroideY,
          incertidumbre: resultadoYolo.incertidumbre
        });
        if (autoSeguirPiscina) {
          setZoomCenter({ x: resultadoYolo.centroideX, y: resultadoYolo.centroideY });
        }
        setModoValidacion('Binaria');
        setModificadoSinGuardar(false);

        registrarFrameEnCatalogoMaestro(frameIdExplicito, {
          frameNumber: numFrameExplicito,
          poligonoIA: resultadoYolo.vertices,
          poligono: resultadoYolo.vertices,
          validadoPorExperto: false,
          tipoValidacion: 'PreSegmentacion_YOLO_Carlos',
          algoritmoOrigen: 'YOLO_CARLOS',
          ...resultadoYolo
        });
        return resultadoYolo.vertices;
      }
    }

    const imgData = ctx.getImageData(0, 0, FLIR_WIDTH, FLIR_HEIGHT).data;
    const ancla = ultimoCentroExpertoRef.current;
    const xMinROI = ancla ? Math.max(35, ancla.x - 130) : 35;
    const xMaxROI = ancla ? Math.min(605, ancla.x + 130) : 605;
    const yMinROI = ancla ? Math.max(35, ancla.y - 95) : 35;
    const yMaxROI = ancla ? Math.min(475, ancla.y + 95) : 475;

    let maxLumGlobal = 0;
    let sumFondoLum = 0;
    let countMuestras = 0;

    for (let y = yMinROI; y < yMaxROI; y += 2) {
      for (let x = xMinROI; x < xMaxROI; x += 2) {
        const lum = imgData[(y * FLIR_WIDTH + x) * 4];
        if (lum > maxLumGlobal) maxLumGlobal = lum;
        sumFondoLum += lum;
        countMuestras++;
      }
    }

    const mediaLum = countMuestras > 0 ? sumFondoLum / countMuestras : 0;

    if (maxLumGlobal < 45 || (maxLumGlobal - mediaLum) < 28) {
      setEsPuntoMuerto(true);
      setPoligonoIA([]);
      setPoligono([]);
      return [];
    }
    setEsPuntoMuerto(false);

    const ratioUmbral = umbralCustom / 255;
    const umbralNucleoPuro = Math.max(maxLumGlobal * 0.90, maxLumGlobal * ratioUmbral);

    let sumCoreY = 0;
    let countCore = 0;
    let minCoreX = FLIR_WIDTH;
    let maxCoreX = 0;
    let sumCoreX = 0;

    for (let y = yMinROI; y < yMaxROI; y++) {
      for (let x = xMinROI; x < xMaxROI; x++) {
        const lum = imgData[(y * FLIR_WIDTH + x) * 4];
        if (lum >= umbralNucleoPuro) {
          sumCoreX += x;
          sumCoreY += y;
          countCore++;
          if (x < minCoreX) minCoreX = x;
          if (x > maxCoreX) maxCoreX = x;
        }
      }
    }

    if (countCore < 4) return [];

    let cy = Math.round(sumCoreY / countCore);
    let cx = Math.round(sumCoreX / countCore);

    const umbralEfectivo = Math.max(maxLumGlobal * 0.78, umbralNucleoPuro * 0.88);
    let radioArriba = 5;
    let radioAbajo = 5;

    for (let r = 2; r < 50; r++) {
      const pyUp = Math.max(5, cy - r);
      const lumUp = imgData[(pyUp * FLIR_WIDTH + cx) * 4];
      if (lumUp >= umbralEfectivo) radioArriba = r;
      else if (r > radioArriba + 2) break;
    }

    for (let r = 2; r < 50; r++) {
      const pyDown = Math.min(506, cy + r);
      const lumDown = imgData[(pyDown * FLIR_WIDTH + cx) * 4];
      if (lumDown >= umbralEfectivo) radioAbajo = r;
      else if (r > radioAbajo + 2) break;
    }

    const radioBasePool = Math.min(22, Math.max(8, Math.round((radioArriba + radioAbajo) / 2)));
    const anchoManchaBlanca = maxCoreX - minCoreX;

    if (usarRecorteCola && anchoManchaBlanca > radioBasePool * 2.1) {
      if (direccionSoldadura === 'Derecha a Izquierda') {
        cx = Math.round(minCoreX + radioBasePool * 1.1);
      } else {
        cx = Math.round(maxCoreX - radioBasePool * 1.1);
      }
    }

    let sumYLocal = 0;
    let countYLocal = 0;
    for (let y = Math.max(20, cy - 30); y <= Math.min(490, cy + 30); y++) {
      const lum = imgData[(y * FLIR_WIDTH + cx) * 4];
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

    const maxRadioHorizontal = usarRecorteCola ? Math.round(radioBasePool * 1.35) : 110;
    const maxRadioVertical = usarRecorteCola ? Math.round(radioBasePool * 1.05) : 80;

    for (let i = 0; i < numVertices; i++) {
      const angulo = (i * 2 * Math.PI) / numVertices;
      const cos = Math.cos(angulo);
      const sin = Math.sin(angulo);

      const limiteElipse = Math.sqrt(
        Math.pow(maxRadioHorizontal * cos, 2) +
        Math.pow(maxRadioVertical * sin, 2)
      );
      const rMaxRayo = Math.round(limiteElipse);
      let ultimoRadioValido = Math.max(5, Math.round(radioBasePool * 0.65));

      for (let r = 2; r <= rMaxRayo; r++) {
        const px = Math.round(cx + r * cos);
        const py = Math.round(cy + r * sin);
        if (px <= 5 || px >= 635 || py <= 5 || py >= 507) break;

        const lum = imgData[(py * FLIR_WIDTH + px) * 4];

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

    const promedioLum = muestrasPool > 0 ? sumLumPool / muestrasPool : maxLumGlobal * 0.92;
    const minADBase = matriz14BitActualRef.current?.minAD || 1042;
    const maxADBase = matriz14BitActualRef.current?.maxAD || 7082;
    const adMax = Math.round(minADBase + (maxLumGlobal / 255) * (maxADBase - minADBase));
    const adPromedio = Math.round(minADBase + (promedioLum / 255) * (maxADBase - minADBase));
    const incertidumbreCalc = Number(Math.min(24.5, Math.max(6.5, 8 + (bordeDifuso / (numVertices * 3)) * 10)).toFixed(1));

    setPoligonoIA(verticesDetectados);
    setPoligono(verticesDetectados);
    setTelemetriaPool({
      adMax,
      adPromedio,
      adMin: minADBase,
      deltaTermico: adMax - minADBase,
      centroideX: cx,
      centroideY: cy,
      incertidumbre: incertidumbreCalc
    });

    if (autoSeguirPiscina) {
      setZoomCenter({ x: cx, y: cy });
    }

    setModoValidacion('Binaria');
    setModificadoSinGuardar(false);
    inicioTiempoRef.current = Date.now();

    registrarFrameEnCatalogoMaestro(frameIdExplicito, {
      frameNumber: numFrameExplicito,
      poligonoIA: verticesDetectados,
      poligono: verticesDetectados,
      validadoPorExperto: false,
      tipoValidacion: 'PreSegmentacion_Automatica',
      algoritmoOrigen: motorPreSegmentacion,
      adMax,
      adPromedio,
      adMin: minADBase,
      centroideX: cx,
      centroideY: cy,
      incertidumbre: incertidumbreCalc
    });

    return verticesDetectados;
  }, [
    umbralIsotermico, imgElement, recorteEstela, identificadorFrame, frameActual,
    archivoAtsCrudo, dibujarFuenteTermicaNativa, motorPreSegmentacion,
    ejecutarAlgoritmoCarlosYOLO, autoSeguirPiscina, direccionSoldadura,
    registrarFrameEnCatalogoMaestro
  ]);

  const calibrarDesdePoligonoExperto = (puntosExperto) => {
    if (!puntosExperto || puntosExperto.length < 3) return;
    const offscreen = document.createElement('canvas');
    offscreen.width = FLIR_WIDTH;
    offscreen.height = FLIR_HEIGHT;
    const ctx = offscreen.getContext('2d');
    dibujarFuenteTermicaNativa(ctx, FLIR_WIDTH, FLIR_HEIGHT, imgElement, true);
    const imgData = ctx.getImageData(0, 0, FLIR_WIDTH, FLIR_HEIGHT).data;

    let sumaLumBorde = 0;
    puntosExperto.forEach((pt) => {
      const px = Math.max(0, Math.min(639, pt.x));
      const py = Math.max(0, Math.min(511, pt.y));
      const lum = imgData[(py * FLIR_WIDTH + px) * 4];
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
      x: Math.max(0, Math.min(FLIR_WIDTH, telemetriaPool.centroideX + off.dx)),
      y: Math.max(0, Math.min(FLIR_HEIGHT, telemetriaPool.centroideY + off.dy))
    }));
    setPoligono(nuevosPuntos);
    setModoValidacion('Poligono');
    setModificadoSinGuardar(true);
    setMensajeEstado('Contorno experto adaptado al centroide actual');
  };

  // =========================================================================
  // EFECTO DE CARGA CON DEBOUNCE (250ms) Y CACHÉ ANTI-FLOOD
  // =========================================================================
  useEffect(() => {
    let cancelado = false;

    const timer = setTimeout(async () => {
      if (cancelado) return;

      if (archivoAtsCrudo) {
        await decodificarFrameDesdeATS(archivoAtsCrudo, frameActual, ajusteFilaAts, ajusteColAts);
      }

      let docGuardado = cacheFramesMongoRef.current[identificadorFrame];

      if (docGuardado === undefined) {
        try {
          const res = await axios.get(`${API_URL}/frame/${encodeURIComponent(identificadorFrame)}`);
          docGuardado = res.data?.existe ? res.data.data : null;
          cacheFramesMongoRef.current[identificadorFrame] = docGuardado;
        } catch {
          docGuardado = null;
          cacheFramesMongoRef.current[identificadorFrame] = null;
        }
      }

      if (cancelado) return;

      if (docGuardado) {
        const polyIA = docGuardado.poligonoPreEtiquetado?.length ? docGuardado.poligonoPreEtiquetado : docGuardado.poligono;
        const polyFinal = docGuardado.poligono || [];
        setPoligonoIA(polyIA);
        setPoligono(polyFinal);
        setModoValidacion(docGuardado.tipoValidacion === 'Poligono' ? 'Poligono' : 'Binaria');
        setEstadoBD(docGuardado.estado || 'Revisado');
        setModificadoSinGuardar(false);

        if (polyFinal.length >= 3 && autoSeguirPiscina) {
          const cx = Math.round(polyFinal.reduce((a, b) => a + b.x, 0) / polyFinal.length);
          const cy = Math.round(polyFinal.reduce((a, b) => a + b.y, 0) / polyFinal.length);
          setZoomCenter({ x: cx, y: cy });
        }

        registrarFrameEnCatalogoMaestro(identificadorFrame, {
          frameNumber: frameActual,
          poligonoIA: polyIA,
          poligono: polyFinal,
          validadoPorExperto: docGuardado.estado === 'Revisado',
          tipoValidacion: docGuardado.tipoValidacion,
          adMax: docGuardado.metadatos?.tempMaxima || 7082,
          adPromedio: docGuardado.metadatos?.tempPromedio || 6100,
          iouSimilitud: docGuardado.metadatos?.iouSimilitud ?? 100,
          tiempoValidacionSeg: docGuardado.metadatos?.tiempoValidacionSeg || 0
        });

        setMensajeEstado(`Recuperado de Atlas: ${identificadorFrame}`);
        inicioTiempoRef.current = Date.now();
        return;
      }

      setEstadoBD('Pendiente');
      const vertices = await ejecutarPreSegmentacionIA(
        umbralIsotermico,
        imgElement,
        recorteEstela,
        identificadorFrame,
        frameActual
      );

      if (!cancelado) {
        if (vertices.length === 0) {
          setMensajeEstado(`Fotograma #${frameActual}: Punto muerto detectado (Láser inactivo)`);
        } else {
          setMensajeEstado(`Fotograma #${frameActual}: Cama fundida detectada y enfocada (${zoomLevel}x)`);
        }
      }
    }, 250);

    return () => {
      cancelado = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identificadorFrame, frameActual, archivoAtsCrudo, imgElement, ajusteFilaAts, ajusteColAts]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  const handleSaltarAPrximoFrameActivo = useCallback(async (direccion = 1) => {
    if (!archivoAtsCrudo) {
      const sig = Math.max(1, Math.min(totalFrames, frameActual + direccion * 15));
      setFrameActual(sig);
      if (loteFotogramas.length > 0) setIndiceLote(sig - 1);
      return;
    }

    setBuscandoFrameActivo(true);
    setMensajeEstado('Escaneando archivo .ATS para omitir puntos muertos...');

    let candidato = frameActual + direccion;
    const pasoBusqueda = 12;
    let encontrado = candidato;

    while (candidato >= 1 && candidato <= totalFrames) {
      const info = await decodificarFrameDesdeATS(archivoAtsCrudo, candidato, ajusteFilaAts, ajusteColAts);
      if (info && !info.esPuntoMuerto) {
        encontrado = candidato;
        break;
      }
      candidato += direccion * pasoBusqueda;
    }

    encontrado = Math.max(1, Math.min(totalFrames, encontrado));
    setFrameActual(encontrado);
    setBuscandoFrameActivo(false);
  }, [archivoAtsCrudo, totalFrames, frameActual, loteFotogramas.length, decodificarFrameDesdeATS, ajusteFilaAts, ajusteColAts]);

  const handleCargarArchivoATS = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoteFotogramas([]);
    setArchivoAtsCrudo(file);
    setSecuenciaActiva(file.name);
    ultimoCentroExpertoRef.current = null;

    const framesCalculados = Math.max(1, Math.floor(file.size / 656638));
    setTotalFrames(framesCalculados);
    setIndiceLote(0);

    let frameInicial = 1;
    for (let f = 1; f <= framesCalculados; f += 40) {
      const info = await decodificarFrameDesdeATS(file, f, ajusteFilaAts, ajusteColAts);
      if (info && !info.esPuntoMuerto) {
        frameInicial = f;
        break;
      }
    }

    setFrameActual(frameInicial);
    await decodificarFrameDesdeATS(file, frameInicial, ajusteFilaAts, ajusteColAts);
    await ejecutarPreSegmentacionIA(umbralIsotermico, null, recorteEstela, `${file.name}_frame_${frameInicial}`, frameInicial);
    setMensajeEstado(`Archivo ${file.name} montado. Inicio activo en fotograma #${frameInicial}`);
  };

  const handleSubirLoteImagenes = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setArchivoAtsCrudo(null);
    matriz14BitActualRef.current = null;
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
    setTotalFrames(imagenesCargadas.length);
    setIndiceLote(0);
    setFrameActual(1);

    const primerId = `${secuenciaActiva}_${imagenesCargadas[0].nombreArchivo.replace(/\.[^/.]+$/, '')}`;
    await ejecutarPreSegmentacionIA(umbralIsotermico, imagenesCargadas[0].imgElement, recorteEstela, primerId, 1);
    setMensajeEstado(`Lote cargado: ${imagenesCargadas.length} fotogramas listos`);
  };

  const handlePreSegmentarSecuenciaCompleta = async () => {
    if (procesandoLoteMasivo) return;
    setProcesandoLoteMasivo(true);
    setProgresoLote(0);

    const loteParaBackend = [];
    const salto = loteFotogramas.length > 0 ? 1 : Math.max(1, pasoMuestreoLote);
    let framesActivosEncontrados = 0;
    let framesMuertosDescartados = 0;

    for (let numFrame = 1; numFrame <= totalFrames; numFrame += salto) {
      const idx = numFrame - 1;
      const itemImg = loteFotogramas.length > 0 ? loteFotogramas[idx] : null;
      const fId = archivoAtsCrudo
        ? `${secuenciaActiva}_frame_${numFrame}`
        : itemImg
        ? `${secuenciaActiva}_${itemImg.nombreArchivo.replace(/\.[^/.]+$/, '')}`
        : `${secuenciaActiva}_frame_${numFrame}`;

      if (!registroSecuenciaRef.current[fId]?.validadoPorExperto) {
        if (archivoAtsCrudo) {
          const info = await decodificarFrameDesdeATS(archivoAtsCrudo, numFrame, ajusteFilaAts, ajusteColAts);
          if (omitirPuntosMuertos && (!info || info.esPuntoMuerto)) {
            framesMuertosDescartados++;
            continue;
          }
        }

        const ptsDetectados = await ejecutarPreSegmentacionIA(
          umbralIsotermico,
          itemImg ? itemImg.imgElement : null,
          recorteEstela,
          fId,
          numFrame
        );

        if (ptsDetectados.length >= 3) {
          framesActivosEncontrados++;
          const reg = registroSecuenciaRef.current[fId];
          if (reg) {
            loteParaBackend.push({
              frameId: fId,
              imageUrl: `/dataset/${secuenciaActiva}/${fId}.png`,
              poligonoPreEtiquetado: ptsDetectados,
              poligono: ptsDetectados,
              tempMaxima: reg.metadatos.tempMaxima,
              tempPromedio: reg.metadatos.tempPromedio,
              incertidumbreAlgoritmo: reg.metadatos.incertidumbreAlgoritmo,
              direccionSoldadura,
              material,
              numeroCordones: cordones
            });
          }
        } else {
          framesMuertosDescartados++;
        }
      }

      setProgresoLote(Math.min(99, Math.round((numFrame / totalFrames) * 100)));
      await new Promise((r) => setTimeout(r, 2));
    }

    if (loteParaBackend.length > 0) {
      try {
        await axios.post(`${API_URL}/batch`, { frames: loteParaBackend.slice(0, 350) });
      } catch {
        // Catálogo local listo para exportar
      }
    }

    setProgresoLote(100);
    setProcesandoLoteMasivo(false);
    setMensajeEstado(
      `Lote listo: ${framesActivosEncontrados} activos registrados (${framesMuertosDescartados} puntos muertos omitidos)`
    );
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

  // Renderizado del Lienzo con Cámara de Zoom Inteligente (1x a 6x)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const offscreen = document.createElement('canvas');
    offscreen.width = FLIR_WIDTH;
    offscreen.height = FLIR_HEIGHT;
    const offCtx = offscreen.getContext('2d');
    dibujarFuenteTermicaNativa(offCtx, FLIR_WIDTH, FLIR_HEIGHT, imgElement, false);

    const { vx, vy, viewW, viewH } = obtenerVentanaZoom();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(offscreen, vx, vy, viewW, viewH, 0, 0, FLIR_WIDTH, FLIR_HEIGHT);

    const toScreenX = (x) => ((x - vx) / viewW) * FLIR_WIDTH;
    const toScreenY = (y) => ((y - vy) / viewH) * FLIR_HEIGHT;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    const pasoGrid = zoomLevel >= 3 ? 16 : 64;
    const startGridX = Math.floor(vx / pasoGrid) * pasoGrid;
    const startGridY = Math.floor(vy / pasoGrid) * pasoGrid;

    for (let gx = startGridX; gx <= vx + viewW; gx += pasoGrid) {
      const sx = toScreenX(gx);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, canvas.height);
      ctx.stroke();
    }
    for (let gy = startGridY; gy <= vy + viewH; gy += pasoGrid) {
      const sy = toScreenY(gy);
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(canvas.width, sy);
      ctx.stroke();
    }

    if (esPuntoMuerto) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
      ctx.fillRect(140, 215, 360, 70);
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
      ctx.strokeRect(140, 215, 360, 70);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '600 13px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('PUNTO MUERTO DETECTADO (SIN LÁSER ACTIVO)', 320, 244);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px Inter, sans-serif';
      ctx.fillText('Use el botón "Saltar Puntos Muertos ⚡" para ir al siguiente cordón', 320, 266);
      return;
    }

    if (mostrarGuiaIA && poligonoIA.length >= 3 && iouActual < 100) {
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(toScreenX(poligonoIA[0].x), toScreenY(poligonoIA[0].y));
      for (let i = 1; i < poligonoIA.length; i++) {
        ctx.lineTo(toScreenX(poligonoIA[i].x), toScreenY(poligonoIA[i].y));
      }
      ctx.closePath();
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    if (poligono.length > 0) {
      ctx.beginPath();
      ctx.moveTo(toScreenX(poligono[0].x), toScreenY(poligono[0].y));
      for (let i = 1; i < poligono.length; i++) {
        ctx.lineTo(toScreenX(poligono[i].x), toScreenY(poligono[i].y));
      }
      if (poligono.length >= 3) {
        ctx.closePath();
        ctx.fillStyle = modoValidacion === 'Binaria'
          ? 'rgba(16, 185, 129, 0.20)'
          : 'rgba(56, 189, 248, 0.22)';
        ctx.fill();
      }
      ctx.strokeStyle = modoValidacion === 'Binaria' ? '#10b981' : '#38bdf8';
      ctx.lineWidth = 2;
      ctx.stroke();

      poligono.forEach((pt, idx) => {
        const sx = toScreenX(pt.x);
        const sy = toScreenY(pt.y);
        ctx.fillStyle = idx === 0 ? '#ffffff' : (modoValidacion === 'Binaria' ? '#10b981' : '#38bdf8');
        ctx.beginPath();
        ctx.arc(sx, sy, 4.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      });
    }

    const scx = toScreenX(telemetriaPool.centroideX);
    const scy = toScreenY(telemetriaPool.centroideY);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(scx - 6, scy);
    ctx.lineTo(scx + 6, scy);
    ctx.moveTo(scx, scy - 6);
    ctx.lineTo(scx, scy + 6);
    ctx.stroke();
  }, [
    poligono, poligonoIA, mostrarGuiaIA, modoValidacion, dibujarFuenteTermicaNativa,
    imgElement, telemetriaPool, iouActual, obtenerVentanaZoom, zoomLevel, esPuntoMuerto
  ]);

  const obtenerCoordenadasCanvas = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { vx, vy, viewW, viewH } = obtenerVentanaZoom();

    const imgX = Math.round(vx + (sx / FLIR_WIDTH) * viewW);
    const imgY = Math.round(vy + (sy / FLIR_HEIGHT) * viewH);

    return {
      x: Math.max(0, Math.min(FLIR_WIDTH, imgX)),
      y: Math.max(0, Math.min(FLIR_HEIGHT, imgY))
    };
  };

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    const { x, y } = obtenerCoordenadasCanvas(e);
    const radioCaptura = Math.max(2.5, 9 / zoomLevel);

    const idxExistente = poligono.findIndex((pt) => Math.hypot(pt.x - x, pt.y - y) <= radioCaptura);
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

    if (archivoAtsCrudo && matriz14BitActualRef.current) {
      const { raw16 } = matriz14BitActualRef.current;
      const idx14 = Math.min(511, y) * FLIR_WIDTH + Math.min(639, x);
      const counts = raw16[idx14];
      setCursorPos({ x, y, counts });
      return;
    }

    setCursorPos({ x, y, counts: telemetriaPool.adPromedio });
  };

  const handleMouseUp = () => {
    setVerticeArrastrado(null);
  };

  const handleWheelZoom = (e) => {
    e.preventDefault();
    const { x, y } = obtenerCoordenadasCanvas(e);
    const delta = e.deltaY < 0 ? 0.5 : -0.5;
    setZoomLevel((prev) => {
      const nuevo = Number(Math.max(1, Math.min(6, prev + delta)).toFixed(1));
      if (nuevo > 1) {
        setZoomCenter({ x, y });
      }
      return nuevo;
    });
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    const { x, y } = obtenerCoordenadasCanvas(e);
    const radioCaptura = Math.max(3, 10 / zoomLevel);
    const idxEliminar = poligono.findIndex((pt) => Math.hypot(pt.x - x, pt.y - y) <= radioCaptura);
    if (idxEliminar !== -1) {
      setModoValidacion('Poligono');
      setPoligono((prev) => prev.filter((_, idx) => idx !== idxEliminar));
      setModificadoSinGuardar(true);
    }
  };

  const irAFotograma = useCallback((nuevoValorFrame) => {
    const frameClamped = Math.max(1, Math.min(totalFrames, nuevoValorFrame));
    if (loteFotogramas.length > 0) {
      setIndiceLote(frameClamped - 1);
      setFrameActual(frameClamped);
    } else {
      setFrameActual(frameClamped);
    }
  }, [totalFrames, loteFotogramas.length]);

  const handleGuardarValidacion = useCallback(async (avanzarDespues = autoAvanzar) => {
    if (esPuntoMuerto) {
      if (avanzarDespues) {
        await handleSaltarAPrximoFrameActivo(1);
      }
      return;
    }

    setGuardando(true);
    const ahora = Date.now();
    const inicio = inicioTiempoRef.current || ahora;
    const tiempoSegundos = Number(((ahora - inicio) / 1000).toFixed(1));

    if (modoValidacion === 'Poligono' && poligono.length >= 3) {
      calibrarDesdePoligonoExperto(poligono);
    }

    registrarFrameEnCatalogoMaestro(identificadorFrame, {
      frameNumber: frameActual,
      poligonoIA,
      poligono,
      validadoPorExperto: true,
      tipoValidacion: modoValidacion,
      algoritmoOrigen: motorPreSegmentacion,
      adMax: telemetriaPool.adMax,
      adPromedio: telemetriaPool.adPromedio,
      adMin: telemetriaPool.adMin,
      centroideX: telemetriaPool.centroideX,
      centroideY: telemetriaPool.centroideY,
      incertidumbre: telemetriaPool.incertidumbre,
      iouSimilitud: iouActual,
      tiempoValidacionSeg: tiempoSegundos
    });

    try {
      const payload = {
        frameId: identificadorFrame,
        imageUrl: `/dataset/${secuenciaActiva}/${identificadorFrame}.png`,
        estado: 'Revisado',
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

      const res = await axios.post(API_URL, payload);
      cacheFramesMongoRef.current[identificadorFrame] = res.data?.data || payload;
      setEstadoBD('Revisado');
      setModificadoSinGuardar(false);
      setMensajeEstado(`Guardado #${frameActual} (${tiempoSegundos}s | IoU: ${iouActual}%)`);
    } catch {
      setMensajeEstado('Guardado en catálogo maestro local');
    } finally {
      setGuardando(false);
      if (avanzarDespues && frameActual < totalFrames) {
        irAFotograma(frameActual + 1);
      }
    }
  }, [
    autoAvanzar, esPuntoMuerto, handleSaltarAPrximoFrameActivo, modoValidacion,
    poligono, poligonoIA, identificadorFrame, frameActual, motorPreSegmentacion,
    telemetriaPool, iouActual, umbralIsotermico, direccionSoldadura, material,
    cordones, secuenciaActiva, totalFrames, irAFotograma, registrarFrameEnCatalogoMaestro
  ]);

  const handleNavegarSeguro = useCallback(async (direccion) => {
    if (modificadoSinGuardar && poligono.length >= 3 && !esPuntoMuerto) {
      await handleGuardarValidacion(false);
    }
    irAFotograma(frameActual + direccion);
  }, [modificadoSinGuardar, poligono.length, esPuntoMuerto, handleGuardarValidacion, irAFotograma, frameActual]);

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
      const docsRevisados = docs.filter((d) => d.estado === 'Revisado');
      if (docsRevisados.length > 0) {
        const total = docsRevisados.length;
        const sumaTiempo = docsRevisados.reduce((acc, d) => acc + (d.metadatos?.tiempoValidacionSeg || 2.5), 0);
        const sumaIoU = docsRevisados.reduce((acc, d) => acc + (d.metadatos?.iouSimilitud ?? 100), 0);
        const confirmaciones = docsRevisados.filter((d) => d.tipoValidacion === 'Binaria').length;

        setResumenMetricas({
          totalValidados: total,
          totalPreSegmentados: Math.max(docs.length, Object.keys(registroSecuenciaRef.current).length),
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
    maskCanvas.width = FLIR_WIDTH;
    maskCanvas.height = FLIR_HEIGHT;
    const mCtx = maskCanvas.getContext('2d');

    mCtx.fillStyle = '#000000';
    mCtx.fillRect(0, 0, FLIR_WIDTH, FLIR_HEIGHT);

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
      let registrosMongo = [];
      try {
        const res = await axios.get(`${API_URL}?secuencia=${secuenciaActiva}`);
        registrosMongo = res.data || [];
      } catch {
        registrosMongo = [];
      }

      const mapaConsolidado = { ...registroSecuenciaRef.current };

      registrosMongo.forEach((doc) => {
        if (doc.poligono && doc.poligono.length >= 3) {
          mapaConsolidado[doc.frameId] = {
            frameId: doc.frameId,
            frameNumber: mapaConsolidado[doc.frameId]?.frameNumber || 1,
            fileName: `${doc.frameId}.png`,
            poligonoIA: doc.poligonoPreEtiquetado?.length ? doc.poligonoPreEtiquetado : doc.poligono,
            poligono: doc.poligono || [],
            validadoPorExperto: doc.estado === 'Revisado',
            tipoValidacion: doc.tipoValidacion || 'Binaria',
            algoritmoOrigen: motorPreSegmentacion,
            metadatos: {
              ...METADATOS_FLIR_BASE,
              ...doc.metadatos
            }
          };
        }
      });

      const listaExportar = Object.values(mapaConsolidado).sort((a, b) =>
        a.frameId.localeCompare(b.frameId, undefined, { numeric: true })
      );

      const totalRectificados = listaExportar.filter((item) => item.validadoPorExperto).length;
      const totalSoloIA = listaExportar.length - totalRectificados;

      const cocoDataset = {
        info: {
          description: `CIDESI - Dataset Termográfico Completo DED-LB (${secuenciaActiva})`,
          version: '2.0',
          year: 2026,
          contributor: localStorage.getItem('expertEmail') || 'Investigador CIDESI',
          presegmentation_engine: motorPreSegmentacion,
          total_processed_frames: listaExportar.length,
          expert_rectified_frames: totalRectificados,
          ai_presegmented_only_frames: totalSoloIA
        },
        images: listaExportar.map((item, idx) => ({
          id: idx + 1,
          file_name: item.fileName || `${item.frameId}.png`,
          frame_id: item.frameId,
          width: FLIR_WIDTH,
          height: FLIR_HEIGHT,
          flir_metadata: {
            camera_model: METADATOS_FLIR_BASE.cameraModel,
            ad_bits: METADATOS_FLIR_BASE.adBits,
            fps: METADATOS_FLIR_BASE.fps,
            emissivity: METADATOS_FLIR_BASE.emissivity,
            distance_m: METADATOS_FLIR_BASE.distanceMeters,
            reflected_temp_c: METADATOS_FLIR_BASE.reflectedTempC,
            relative_humidity_pct: METADATOS_FLIR_BASE.relativeHumidity,
            max_counts_ad: item.metadatos?.tempMaxima || telemetriaPool.adMax,
            mean_counts_ad: item.metadatos?.tempPromedio || telemetriaPool.adPromedio,
            min_counts_ad: item.metadatos?.tempMinima || telemetriaPool.adMin,
            welding_direction: item.metadatos?.direccionSoldadura || direccionSoldadura,
            material: item.metadatos?.material || material,
            numero_cordones: item.metadatos?.numeroCordones || cordones
          }
        })),
        annotations: listaExportar.map((item, idx) => {
          const geo = calcularGeometria(item.poligono);
          return {
            id: idx + 1,
            image_id: idx + 1,
            category_id: 1,
            segmentation: [item.poligono.flatMap((p) => [p.x, p.y])],
            ai_pre_segmentation: [item.poligonoIA?.flatMap((p) => [p.x, p.y]) || []],
            area: item.metadatos?.areaPixeles || geo.area,
            perimeter: item.metadatos?.perimetroPixeles || geo.perimetro,
            centroid: [
              item.metadatos?.centroideX || telemetriaPool.centroideX,
              item.metadatos?.centroideY || telemetriaPool.centroideY
            ],
            iou_agreement: item.metadatos?.iouSimilitud ?? 100,
            validation_time_sec: item.metadatos?.tiempoValidacionSeg ?? 0,
            iscrowd: 0,
            validated_by_human: Boolean(item.validadoPorExperto),
            validation_status: item.validadoPorExperto ? 'expert_rectified' : 'ai_presegmented',
            validation_mode: item.tipoValidacion
          };
        }),
        categories: [{ id: 1, name: 'molten_pool', supercategory: 'welding_thermal' }]
      };

      const blob = new Blob([JSON.stringify(cocoDataset, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `COCO_COMPLETO_${secuenciaActiva.replace('.ats', '')}_${listaExportar.length}frames.json`;
      a.click();
      setMensajeEstado(
        `COCO exportado: ${listaExportar.length} frames activos (${totalRectificados} rectificados + ${totalSoloIA} pre-etiquetados)`
      );
    } catch {
      setMensajeEstado('Error al consolidar la exportación COCO');
    }
  };

  const handleCerrarSesion = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('expertId');
    localStorage.removeItem('expertEmail');
    navigate('/login');
  };

  const gradienteBarraEscala =
    paletaTermica === 'ironbow'
      ? 'linear-gradient(to bottom, #ffffff 0%, #facc15 18%, #f97316 42%, #dc2626 68%, #4a0424 88%, #050505 100%)'
      : paletaTermica === 'redhot'
      ? 'linear-gradient(to bottom, #ffffff 0%, #fb923c 22%, #ef4444 55%, #7f1d1d 82%, #050505 100%)'
      : 'linear-gradient(to bottom, #ffffff 0%, #a1a1aa 45%, #27272a 80%, #09090b 100%)';

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '13px', fontWeight: '700', letterSpacing: '0.04em', color: 'var(--text-primary)' }}>
            CIDESI
          </span>
          <span style={{ color: 'var(--border-color)' }}>/</span>
          <select
            value={secuenciaActiva}
            onChange={(e) => setSecuenciaActiva(e.target.value)}
            className="input-field"
            style={{ width: 'auto', height: '30px', fontSize: '12px' }}
          >
            <option value="RC1.ats">RC1.ats (5.05 GB)</option>
            <option value="RC2.ats">RC2.ats (4.66 GB)</option>
            <option value="RC3.ats">RC3.ats (4.43 GB)</option>
            <option value="RC4.ats">RC4.ats (4.52 GB)</option>
          </select>

          <select
            value={paletaTermica}
            onChange={(e) => setPaletaTermica(e.target.value)}
            className="input-field"
            style={{ width: 'auto', height: '30px', fontSize: '12px' }}
          >
            <option value="ironbow">Paleta: Rojizo Térmico (Ironbow)</option>
            <option value="redhot">Paleta: Rojo Incandescente (Red-Hot)</option>
            <option value="grayscale">Paleta: Blanco y Negro (Monocromo)</option>
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label className="btn btn-outline" title="Abrir archivo binario .ATS crudo de FLIR">
            <svg className="icon-svg" viewBox="0 0 24 24">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>{archivoAtsCrudo ? `ATS: ${archivoAtsCrudo.name}` : 'Cargar .ATS'}</span>
            <input
              type="file"
              accept=".ats,.raw,application/octet-stream"
              onChange={handleCargarArchivoATS}
              style={{ display: 'none' }}
            />
          </label>

          <label className="btn btn-outline" title="Cargar carpeta o lote de fotogramas .png/.jpg">
            <svg className="icon-svg" viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>Lote PNG ({loteFotogramas.length || 0})</span>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={handleSubirLoteImagenes}
              style={{ display: 'none' }}
            />
          </label>

          <button
            type="button"
            onClick={handlePreSegmentarSecuenciaCompleta}
            disabled={procesandoLoteMasivo}
            className="btn btn-outline"
            title="Pre-segmenta automáticamente los fotogramas activos e ignora los puntos muertos"
          >
            <svg className="icon-svg" viewBox="0 0 24 24">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            <span>
              {procesandoLoteMasivo
                ? `Filtrando (${progresoLote}%)`
                : `Pre-segmentar Activos (${totalFramesEnRegistro})`}
            </span>
          </button>

          <button onClick={handleAbrirMetricasHITL} className="btn btn-outline">
            <span>Métricas HITL</span>
          </button>

          <button onClick={handleDescargarMascaraBinaria} className="btn btn-outline">
            <span>Máscara PNG</span>
          </button>

          <button onClick={handleExportarCOCO} className="btn btn-outline">
            <span>Exportar COCO Total</span>
          </button>

          <button onClick={toggleTheme} className="btn btn-outline" title="Alternar Modo Claro / Oscuro">
            {theme === 'light' ? '🌙' : '☀️'}
          </button>

          <button onClick={handleCerrarSesion} className="btn btn-ghost">
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
                <span className="data-label">Estado Láser</span>
                <span className="data-value" style={{ color: esPuntoMuerto ? '#f59e0b' : '#10b981' }}>
                  {esPuntoMuerto ? 'Punto Muerto' : 'Fusión Activa'}
                </span>
              </div>
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
              <h2 className="section-title">Lupa / Zoom en Piscina</h2>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', gap: '4px' }}>
                {[1, 2.5, 4, 6].map((z) => (
                  <button
                    key={z}
                    type="button"
                    onClick={() => setZoomLevel(z)}
                    className={`btn ${zoomLevel === z ? 'btn-primary' : 'btn-outline'}`}
                    style={{ flex: 1, height: '28px', padding: 0, fontSize: '11px' }}
                  >
                    {z}x
                  </button>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoSeguirPiscina}
                  onChange={(e) => setAutoSeguirPiscina(e.target.checked)}
                />
                Auto-enfocar cama fundida
              </label>
            </div>
          </div>

          <div className="panel-section">
            <div className="section-header">
              <h2 className="section-title">Metadatos Cabezal .ATS</h2>
            </div>
            <div className="data-list">
              <div className="data-row">
                <span className="data-label">Cámara</span>
                <span className="data-value">{METADATOS_FLIR_BASE.cameraModel}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Emisividad</span>
                <span className="data-value">{METADATOS_FLIR_BASE.emissivity}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Timestamp</span>
                <span className="data-value">{timestampMsActual} ms</span>
              </div>
            </div>

            {archivoAtsCrudo && (
              <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border-color)', display: 'flex', gap: '6px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)' }}>Ajuste Fila Y</label>
                  <input
                    type="number"
                    value={ajusteFilaAts}
                    onChange={(e) => setAjusteFilaAts(Number(e.target.value))}
                    className="input-field"
                    style={{ height: '24px', fontSize: '11px' }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)' }}>Ajuste Col X</label>
                  <input
                    type="number"
                    value={ajusteColAts}
                    onChange={(e) => setAjusteColAts(Number(e.target.value))}
                    className="input-field"
                    style={{ height: '24px', fontSize: '11px' }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="panel-section">
            <div className="section-header">
              <h2 className="section-title">Parámetros de Proceso</h2>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Material Base
                </label>
                <input
                  value={material}
                  onChange={(e) => setMaterial(e.target.value)}
                  className="input-field"
                  style={{ height: '28px', fontSize: '12px' }}
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
                  style={{ height: '28px', fontSize: '12px' }}
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
                  style={{ height: '28px', fontSize: '12px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Paso Muestreo Lote (frames)
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={pasoMuestreoLote}
                  onChange={(e) => setPasoMuestreoLote(Math.max(1, Number(e.target.value)))}
                  className="input-field"
                  style={{ height: '28px', fontSize: '12px' }}
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
                </span>
                <span style={{ color: 'var(--border-color)' }}>|</span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Zoom: <strong style={{ color: 'var(--accent-primary)', fontFamily: 'monospace' }}>{zoomLevel}x</strong>
                </span>
                <span style={{ color: 'var(--border-color)' }}>|</span>
                <span style={{
                  fontSize: '11px',
                  fontWeight: '600',
                  color: esPuntoMuerto
                    ? '#f59e0b'
                    : modificadoSinGuardar
                    ? '#f59e0b'
                    : estadoBD === 'Revisado'
                    ? 'var(--accent-primary)'
                    : '#10b981'
                }}>
                  {esPuntoMuerto
                    ? 'Punto Muerto (Sin Piscina)'
                    : modificadoSinGuardar
                    ? 'Editando (Sin guardar)'
                    : estadoBD === 'Revisado'
                    ? 'Rectificado por Experto'
                    : 'Pre-segmentado por IA'}
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
                width={FLIR_WIDTH}
                height={FLIR_HEIGHT}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onWheel={handleWheelZoom}
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
                <span style={{ fontWeight: '600', color: 'var(--text-primary)' }}>{telemetriaPool.adMax}</span>
                <span>4715</span>
                <div style={{
                  flex: 1,
                  width: '12px',
                  margin: '6px 0',
                  background: gradienteBarraEscala,
                  border: '1px solid var(--border-color)',
                  borderRadius: '2px'
                }} />
                <span>1415</span>
                <span>{telemetriaPool.adMin}</span>
              </div>
            </div>

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
              >
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
              />

              <button
                type="button"
                onClick={() => handleNavegarSeguro(1)}
                disabled={frameActual >= totalFrames}
                className="btn btn-outline"
                style={{ height: '30px', padding: '0 10px', fontSize: '11px' }}
              >
                <span>Siguiente</span>
              </button>

              <button
                type="button"
                onClick={() => handleSaltarAPrximoFrameActivo(1)}
                disabled={buscandoFrameActivo}
                className="btn btn-outline"
                style={{ height: '30px', padding: '0 10px', fontSize: '11px' }}
                title="Salta automáticamente todos los fotogramas muertos donde el láser está apagado"
              >
                <span>{buscandoFrameActivo ? 'Buscando...' : 'Saltar Puntos Muertos ⚡'}</span>
              </button>

              <button
                type="button"
                onClick={() => handleGuardarValidacion(true)}
                disabled={guardando}
                className="btn btn-primary"
                style={{ height: '30px', padding: '0 14px', fontSize: '11px' }}
              >
                <span>{guardando ? 'Guardando...' : 'Guardar y Siguiente'}</span>
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
                <h2 className="section-title">Motor de Pre-Segmentación</h2>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <select
                  value={motorPreSegmentacion}
                  onChange={(e) => setMotorPreSegmentacion(e.target.value)}
                  className="input-field"
                  style={{ height: '30px', fontSize: '12px' }}
                >
                  <option value="YOLO_CARLOS">YOLO Segmentación (Algoritmo Carlos)</option>
                  <option value="ISOTERMICO_LOCAL">Isotérmico Liquidus (Respaldo Local)</option>
                </select>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
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

                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={omitirPuntosMuertos}
                    onChange={(e) => setOmitirPuntosMuertos(e.target.checked)}
                  />
                  Ignorar puntos muertos en lote
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
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

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
                    style={{ width: '100%', marginTop: '2px', height: '26px', fontSize: '11px' }}
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
                  <span>Confirmar IA</span>
                </button>
                <button
                  type="button"
                  onClick={() => setModoValidacion('Poligono')}
                  className={`segment-btn ${modoValidacion === 'Poligono' ? 'active' : ''}`}
                >
                  <span>Rectificar</span>
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
                  maxHeight: '130px',
                  overflowY: 'auto',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px'
                }}>
                  {poligono.length === 0 ? (
                    <div style={{ padding: '12px', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
                      Sin vértices en este fotograma
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
              <span>
                {guardando
                  ? 'Sincronizando...'
                  : esPuntoMuerto
                  ? 'Omitir Punto Muerto ⚡'
                  : autoAvanzar
                  ? 'Guardar y Avanzar'
                  : 'Guardar Validación'}
              </span>
            </button>
          </div>
        </aside>
      </div>

      {/* MODAL DE MÉTRICAS HITL */}
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
                <span className="data-label">Total Fotogramas Activos en COCO</span>
                <span className="data-value">{Math.max(resumenMetricas.totalPreSegmentados, totalFramesEnRegistro)} frames</span>
              </div>
              <div className="data-row">
                <span className="data-label">Fotogramas Rectificados por Experto</span>
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
          </div>
        </div>
      )}
    </div>
  );
}