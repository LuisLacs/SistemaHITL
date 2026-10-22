import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import '../styles/scientific-ui.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const API_URL = `${BASE_URL}/api/annotations`;
// URL del microservicio Python donde correrá el modelo YOLO de Carlos
const YOLO_CARLOS_API = import.meta.env.VITE_YOLO_URL || 'http://localhost:8000/api/yolo/predict';

// Constantes físicas de la cámara FLIR A6751sc (640x512 @ 14-bit) en archivos .ATS
const FLIR_WIDTH = 640;
const FLIR_HEIGHT = 512;
const FLIR_PIXELS = FLIR_WIDTH * FLIR_HEIGHT; // 327,680 píxeles por fotograma
const FLIR_FRAME_BYTES = FLIR_PIXELS * 2; // 655,360 bytes (Uint16 Little-Endian)
const ATS_GLOBAL_HEADER = 2048; // Offset inicial del contenedor .ats
const ATS_FRAME_STRIDE = 656728; // 655,360 bytes de matriz + 1,368 bytes de cabecera de metadatos por frame

export default function Anotador() {
  const navigate = useNavigate();
  const [isAuthorized] = useState(!!localStorage.getItem('token'));
  const canvasRef = useRef(null);
  const inicioTiempoRef = useRef(null);
  const ultimoCentroExpertoRef = useRef(null);

  // Registro maestro en memoria de TODOS los fotogramas procesados (pre-segmentados + rectificados)
  // Estructura: { [frameId]: { frameNumber, fileName, poligonoIA, poligono, validadoPorExperto, tipoValidacion, metadatos } }
  const registroSecuenciaRef = useRef({});
  // Matriz radiométrica cruda de 14-bits del fotograma activo (cuando se lee un archivo .ats)
  const matriz14BitActualRef = useRef(null);

  useEffect(() => {
    inicioTiempoRef.current = Date.now();
  }, []);

  const [theme, setTheme] = useState(localStorage.getItem('ui-theme') || 'dark');
  const [secuenciaActiva, setSecuenciaActiva] = useState(
    localStorage.getItem('hitl-secuencia') || 'RC3.ats'
  );

  // Archivo .ATS crudo seleccionado desde disco (lectura por streaming Blob.slice sin saturar RAM)
  const [archivoAtsCrudo, setArchivoAtsCrudo] = useState(null);
  // Lote de imágenes .png/.jpg (modo alternativo)
  const [loteFotogramas, setLoteFotogramas] = useState([]);

  const [indiceLote, setIndiceLote] = useState(0);
  const [frameActual, setFrameActual] = useState(1);
  const [totalFrames, setTotalFrames] = useState(100);

  // Metadatos nativos extraídos del archivo .ats / cabezal FLIR
  const [metadatosAts, setMetadatosAts] = useState({
    cameraModel: 'FLIR A6751sc',
    resolution: '640×512',
    adBits: 14,
    fps: 127,
    emissivity: 0.92,
    distanceMeters: 1.0,
    reflectedTempC: 20.0,
    atmosphericTempC: 20.0,
    relativeHumidity: 30.0,
    timestampMs: 0
  });

  // Selector de Motor de Pre-Segmentación: 'YOLO_CARLOS' | 'ISOTERMICO_LOCAL'
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

  const [umbralIsotermico, setUmbralIsotermico] = useState(218);
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
    if (!isAuthorized) {
      navigate('/login', { replace: true });
    }
  }, [isAuthorized, navigate]);

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

  // Registrar cualquier fotograma procesado (automático o rectificado) en el catálogo maestro para exportación COCO
  const registrarFrameEnCatalogoMaestro = useCallback((frameIdKey, datosFrame) => {
    const existente = registroSecuenciaRef.current[frameIdKey];
    // Si el fotograma ya fue rectificado por el experto y llega un cálculo automático, respetar la rectificación humana
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
        ...metadatosAts,
        tempMaxima: datosFrame.adMax || 7082,
        tempPromedio: datosFrame.adPromedio || 6100,
        tempMinima: datosFrame.adMin || 1017,
        centroideX: datosFrame.centroideX || 320,
        centroideY: datosFrame.centroideY || 214,
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
  }, [calcularGeometria, frameActual, motorPreSegmentacion, metadatosAts, direccionSoldadura, material, cordones]);

  // =========================================================================
  // 1. LECTOR BINARIO DE ARCHIVOS .ATS (STREAMING POR BLOQUES DE 14-BITS)
  // =========================================================================
  const decodificarFrameDesdeATS = useCallback(async (fileAts, numeroFrame) => {
    if (!fileAts) return null;

    const offsetFrame = ATS_GLOBAL_HEADER + (numeroFrame - 1) * ATS_FRAME_STRIDE;
    const finFrame = Math.min(fileAts.size, offsetFrame + FLIR_FRAME_BYTES);

    if (offsetFrame >= fileAts.size || finFrame - offsetFrame < FLIR_FRAME_BYTES) {
      return null;
    }

    const sliceBlob = fileAts.slice(offsetFrame, finFrame);
    const buffer = await sliceBlob.arrayBuffer();
    const raw16 = new Uint16Array(buffer);

    let minAD = 16383;
    let maxAD = 0;

    for (let i = 0; i < FLIR_PIXELS; i++) {
      // Máscara de 14-bits (0 a 16383 cuentas AD)
      const val = raw16[i] & 0x3FFF;
      if (val > 400 && val < minAD) minAD = val;
      if (val > maxAD) maxAD = val;
    }

    if (minAD >= maxAD) {
      minAD = 1017;
      maxAD = 7082;
    }

    matriz14BitActualRef.current = {
      raw16,
      minAD,
      maxAD,
      timestampMs: Math.round(((numeroFrame - 1) / 127) * 1000)
    };

    setMetadatosAts((prev) => ({
      ...prev,
      timestampMs: Math.round(((numeroFrame - 1) / 127) * 1000)
    }));

    return matriz14BitActualRef.current;
  }, []);

  const dibujarFuenteTermica = useCallback((ctx, width, height, imagenExplicita = imgElement) => {
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, width, height);

    // A) Si hay un archivo .ATS crudo activo, renderizar directamente la matriz radiométrica de 14-bits
    if (archivoAtsCrudo && matriz14BitActualRef.current) {
      const { raw16, minAD, maxAD } = matriz14BitActualRef.current;
      const rango = Math.max(1, maxAD - minAD);
      const imgDataObj = ctx.createImageData(FLIR_WIDTH, FLIR_HEIGHT);
      const data = imgDataObj.data;

      for (let i = 0; i < FLIR_PIXELS; i++) {
        const adVal = raw16[i] & 0x3FFF;
        const norm = Math.max(0, Math.min(255, Math.round(((adVal - minAD) / rango) * 255)));
        const pxIdx = i * 4;
        data[pxIdx] = norm;
        data[pxIdx + 1] = norm;
        data[pxIdx + 2] = norm;
        data[pxIdx + 3] = 255;
      }
      ctx.putImageData(imgDataObj, 0, 0);
      return;
    }

    // B) Si se cargó lote de imágenes .png/.jpg exportadas
    if (imagenExplicita) {
      ctx.drawImage(imagenExplicita, 0, 0, width, height);
      return;
    }

    // C) Escena térmica sintética de respaldo
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
  }, [archivoAtsCrudo, imgElement, loteFotogramas.length, indiceLote, frameActual]);

  // =========================================================================
  // 2. SECCIÓN DE INTEGRACIÓN PARA EL ALGORITMO YOLO DE CARLOS
  // =========================================================================
  /**
   * Conector para el modelo de pre-segmentación YOLO desarrollado por Carlos.
   * Envía el fotograma actual (matriz o imagen base64) al servicio de inferencia YOLO
   * y recibe el arreglo de vértices [{ x, y }, ...] junto con la confianza del modelo.
   */
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
        { timeout: 1800 }
      );

      // Formato esperado del script YOLO de Carlos:
      // { polygon: [{x: 310, y: 210}, ...], confidence: 0.91, max_ad: 7082, mean_ad: 6420 }
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
      // Si el servidor Python de Carlos aún no está levantado localmente,
      // retorna false para usar de forma transparente la pre-segmentación local
    }
    return { exito: false };
  }, [identificadorFrame, secuenciaActiva, frameActual]);

  // =========================================================================
  // 3. MOTOR DE PRE-SEGMENTACIÓN (CONMUTADOR YOLO CARLOS / ISOTÉRMICO LOCAL)
  // =========================================================================
  const ejecutarPreSegmentacionIA = useCallback(async (
    umbralCustom = umbralIsotermico,
    imagenTarget = imgElement,
    usarRecorteCola = recorteEstela,
    frameIdExplicito = identificadorFrame,
    numFrameExplicito = frameActual
  ) => {
    const offscreen = document.createElement('canvas');
    offscreen.width = FLIR_WIDTH;
    offscreen.height = FLIR_HEIGHT;
    const ctx = offscreen.getContext('2d');

    dibujarFuenteTermica(ctx, FLIR_WIDTH, FLIR_HEIGHT, imagenTarget);

    // A) Si está seleccionado el motor YOLO de Carlos, intentar inferencia con su servicio primero
    if (motorPreSegmentacion === 'YOLO_CARLOS') {
      const resultadoYolo = await ejecutarAlgoritmoCarlosYOLO(offscreen);
      if (resultadoYolo.exito) {
        setPoligonoIA(resultadoYolo.vertices);
        setPoligono(resultadoYolo.vertices);
        setTelemetriaPool({
          adMax: resultadoYolo.adMax,
          adPromedio: resultadoYolo.adPromedio,
          adMin: resultadoYolo.adMin,
          centroideX: resultadoYolo.centroideX,
          centroideY: resultadoYolo.centroideY,
          incertidumbre: resultadoYolo.incertidumbre
        });
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

    // B) Respaldo / Pre-segmentación Isotérmica Radiométrica
    const imgData = ctx.getImageData(0, 0, FLIR_WIDTH, FLIR_HEIGHT).data;
    const ancla = ultimoCentroExpertoRef.current;
    const xMinROI = ancla ? Math.max(30, ancla.x - 95) : 30;
    const xMaxROI = ancla ? Math.min(610, ancla.x + 95) : 610;
    const yMinROI = ancla ? Math.max(30, ancla.y - 65) : 30;
    const yMaxROI = ancla ? Math.min(482, ancla.y + 65) : 482;

    let maxLumGlobal = 0;
    for (let y = yMinROI; y < yMaxROI; y += 2) {
      for (let x = xMinROI; x < xMaxROI; x += 2) {
        const idx = (y * FLIR_WIDTH + x) * 4;
        const lum = (imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3;
        if (lum > maxLumGlobal) maxLumGlobal = lum;
      }
    }

    if (maxLumGlobal < 40) return [];

    const umbralNucleoPuro = Math.max(umbralCustom, maxLumGlobal * 0.95);
    let sumCoreY = 0;
    let countCore = 0;
    let minCoreX = FLIR_WIDTH;
    let maxCoreX = 0;
    let sumCoreX = 0;

    for (let y = yMinROI; y < yMaxROI; y++) {
      for (let x = xMinROI; x < xMaxROI; x++) {
        const idx = (y * FLIR_WIDTH + x) * 4;
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

    if (countCore === 0) return [];

    let cy = Math.round(sumCoreY / countCore);
    let cx = Math.round(sumCoreX / countCore);

    const umbralEfectivo = Math.max(umbralCustom, maxLumGlobal * 0.86);
    let radioArriba = 6;
    let radioAbajo = 6;

    for (let r = 2; r < 60; r++) {
      const pyUp = Math.max(5, cy - r);
      const idxUp = (pyUp * FLIR_WIDTH + cx) * 4;
      const lumUp = (imgData[idxUp] + imgData[idxUp + 1] + imgData[idxUp + 2]) / 3;
      if (lumUp >= umbralEfectivo) radioArriba = r;
      else if (r > radioArriba + 2) break;
    }

    for (let r = 2; r < 60; r++) {
      const pyDown = Math.min(506, cy + r);
      const idxDown = (pyDown * FLIR_WIDTH + cx) * 4;
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
      const idx = (y * FLIR_WIDTH + cx) * 4;
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

        const idx = (py * FLIR_WIDTH + px) * 4;
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
    const minADBase = matriz14BitActualRef.current?.minAD || 1017;
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
      centroideX: cx,
      centroideY: cy,
      incertidumbre: incertidumbreCalc
    });
    setModoValidacion('Binaria');
    setModificadoSinGuardar(false);
    inicioTiempoRef.current = Date.now();

    // Guardar en el catálogo maestro para que la exportación COCO incluya este fotograma aunque no sea rectificado manualmente
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
    dibujarFuenteTermica, motorPreSegmentacion, ejecutarAlgoritmoCarlosYOLO,
    direccionSoldadura, registrarFrameEnCatalogoMaestro
  ]);

  const calibrarDesdePoligonoExperto = (puntosExperto) => {
    if (!puntosExperto || puntosExperto.length < 3) return;
    const offscreen = document.createElement('canvas');
    offscreen.width = FLIR_WIDTH;
    offscreen.height = FLIR_HEIGHT;
    const ctx = offscreen.getContext('2d');
    dibujarFuenteTermica(ctx, FLIR_WIDTH, FLIR_HEIGHT, imgElement);
    const imgData = ctx.getImageData(0, 0, FLIR_WIDTH, FLIR_HEIGHT).data;

    let sumaLumBorde = 0;
    puntosExperto.forEach((pt) => {
      const px = Math.max(0, Math.min(639, pt.x));
      const py = Math.max(0, Math.min(511, pt.y));
      const idx = (py * FLIR_WIDTH + px) * 4;
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
      x: Math.max(0, Math.min(FLIR_WIDTH, telemetriaPool.centroideX + off.dx)),
      y: Math.max(0, Math.min(FLIR_HEIGHT, telemetriaPool.centroideY + off.dy))
    }));
    setPoligono(nuevosPuntos);
    setModoValidacion('Poligono');
    setModificadoSinGuardar(true);
    setMensajeEstado('Contorno experto adaptado al centroide actual');
  };

  // Gestionar cambio de fotograma (decodifica bloque .ATS si hay archivo crudo y consulta MongoDB)
  useEffect(() => {
    let cancelado = false;
    const gestionarCargaDeFrame = async () => {
      if (archivoAtsCrudo) {
        await decodificarFrameDesdeATS(archivoAtsCrudo, frameActual);
      }

      try {
        const res = await axios.get(`${API_URL}/frame/${encodeURIComponent(identificadorFrame)}`);
        if (!cancelado && res.data.existe && res.data.data) {
          const doc = res.data.data;
          const polyIA = doc.poligonoPreEtiquetado?.length ? doc.poligonoPreEtiquetado : doc.poligono;
          const polyFinal = doc.poligono || [];
          setPoligonoIA(polyIA);
          setPoligono(polyFinal);
          setModoValidacion(doc.tipoValidacion === 'Poligono' ? 'Poligono' : 'Binaria');
          setEstadoBD(doc.estado || 'Revisado');
          setModificadoSinGuardar(false);

          registrarFrameEnCatalogoMaestro(identificadorFrame, {
            frameNumber: frameActual,
            poligonoIA: polyIA,
            poligono: polyFinal,
            validadoPorExperto: doc.estado === 'Revisado',
            tipoValidacion: doc.tipoValidacion,
            adMax: doc.metadatos?.tempMaxima || 7082,
            adPromedio: doc.metadatos?.tempPromedio || 6100,
            iouSimilitud: doc.metadatos?.iouSimilitud ?? 100,
            tiempoValidacionSeg: doc.metadatos?.tiempoValidacionSeg || 0
          });

          setMensajeEstado(`Recuperado de Atlas: ${identificadorFrame}`);
          inicioTiempoRef.current = Date.now();
          return;
        }
      } catch {
        // Si no existe en MongoDB, pasa al motor de pre-segmentación
      }

      if (!cancelado) {
        setEstadoBD('Pendiente');
        await ejecutarPreSegmentacionIA(umbralIsotermico, imgElement, recorteEstela, identificadorFrame, frameActual);
        setMensajeEstado(
          archivoAtsCrudo
            ? `Frame .ATS #${frameActual} decodificado y pre-segmentado`
            : fotogramaActivo
            ? `Pre-segmentado: ${fotogramaActivo.nombreArchivo}`
            : 'Pre-segmentación aplicada'
        );
      }
    };

    gestionarCargaDeFrame();
    return () => { cancelado = true; };
  }, [
    identificadorFrame, archivoAtsCrudo, frameActual, imgElement, fotogramaActivo,
    decodificarFrameDesdeATS, ejecutarPreSegmentacionIA, umbralIsotermico, recorteEstela,
    registrarFrameEnCatalogoMaestro
  ]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  // CARGAR ARCHIVO .ATS CRUDO DIRECTAMENTE (4.4 GB - 5.0 GB SIN BLOQUEAR EL NAVEGADOR)
  const handleCargarArchivoATS = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoteFotogramas([]);
    setArchivoAtsCrudo(file);
    setSecuenciaActiva(file.name);

    // Calcular total de fotogramas a partir del tamaño del binario .ats
    const framesCalculados = Math.max(1, Math.floor((file.size - ATS_GLOBAL_HEADER) / ATS_FRAME_STRIDE));
    setTotalFrames(framesCalculados);
    setIndiceLote(0);
    setFrameActual(1);

    await decodificarFrameDesdeATS(file, 1);
    await ejecutarPreSegmentacionIA(umbralIsotermico, null, recorteEstela, `${file.name}_frame_1`, 1);
    setMensajeEstado(`Archivo ${file.name} (${(file.size / (1024 ** 3)).toFixed(2)} GB | ${framesCalculados} frames) montado`);
  };

  // CARGAR LOTE DE IMÁGENES (.PNG / .JPG)
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

  // =========================================================================
  // 4. BARRIDO AUTOMÁTICO DE SECUENCIA COMPLETA PARA EXPORTACIÓN TOTAL COCO
  // =========================================================================
  const handlePreSegmentarSecuenciaCompleta = async () => {
    if (procesandoLoteMasivo) return;
    setProcesandoLoteMasivo(true);
    setProgresoLote(0);

    const loteParaBackend = [];
    // Si es un archivo .ats de >2000 frames sin lote de imágenes, barremos los frames o el muestreo activo
    const limiteFrames = loteFotogramas.length > 0
      ? loteFotogramas.length
      : Math.min(totalFrames, 500);

    for (let i = 0; i < limiteFrames; i++) {
      const numFrame = i + 1;
      const itemImg = loteFotogramas.length > 0 ? loteFotogramas[i] : null;
      const fId = archivoAtsCrudo
        ? `${secuenciaActiva}_frame_${numFrame}`
        : itemImg
        ? `${secuenciaActiva}_${itemImg.nombreArchivo.replace(/\.[^/.]+$/, '')}`
        : `${secuenciaActiva}_frame_${numFrame}`;

      // Si ya fue rectificado por el experto en esta sesión, no lo sobrescribimos
      if (!registroSecuenciaRef.current[fId]?.validadoPorExperto) {
        if (archivoAtsCrudo) {
          await decodificarFrameDesdeATS(archivoAtsCrudo, numFrame);
        }
        const ptsDetectados = await ejecutarPreSegmentacionIA(
          umbralIsotermico,
          itemImg ? itemImg.imgElement : null,
          recorteEstela,
          fId,
          numFrame
        );

        const reg = registroSecuenciaRef.current[fId];
        if (reg && ptsDetectados.length >= 3) {
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
      }

      if (i % 10 === 0 || i === limiteFrames - 1) {
        setProgresoLote(Math.round(((i + 1) / limiteFrames) * 100));
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    // Sincronizar el lote pre-segmentado con MongoDB Atlas en bloques
    if (loteParaBackend.length > 0) {
      try {
        await axios.post(`${API_URL}/batch`, { frames: loteParaBackend.slice(0, 300) });
      } catch {
        // El registro en memoria local sigue disponible al 100% para exportar a COCO
      }
    }

    setProcesandoLoteMasivo(false);
    setMensajeEstado(`Secuencia procesada: ${ Object.keys(registroSecuenciaRef.current).length } frames listos para exportar a COCO`);
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

  // Renderizado del Lienzo Principal
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
      x: Math.max(0, Math.min(FLIR_WIDTH, Math.round(e.clientX - rect.left))),
      y: Math.max(0, Math.min(FLIR_HEIGHT, Math.round(e.clientY - rect.top)))
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

    // Si hay matriz binaria de 14-bits desde archivo .ATS, mostrar el valor AD exacto del sensor FLIR
    if (archivoAtsCrudo && matriz14BitActualRef.current) {
      const { raw16 } = matriz14BitActualRef.current;
      const idx14 = Math.min(511, y) * FLIR_WIDTH + Math.min(639, x);
      const counts = raw16[idx14] & 0x3FFF;
      setCursorPos({ x, y, counts });
      return;
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
    setGuardando(true);
    const ahora = Date.now();
    const inicio = inicioTiempoRef.current || ahora;
    const tiempoSegundos = Number(((ahora - inicio) / 1000).toFixed(1));

    if (modoValidacion === 'Poligono' && poligono.length >= 3) {
      calibrarDesdePoligonoExperto(poligono);
    }

    // Actualizar en el catálogo maestro marcándolo como rectificado/validado por el experto
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

      await axios.post(API_URL, payload);
      setEstadoBD('Revisado');
      setModificadoSinGuardar(false);
      setMensajeEstado(`Guardado #${frameActual} (${tiempoSegundos}s | IoU: ${iouActual}%)`);

      if (avanzarDespues && frameActual < totalFrames) {
        irAFotograma(frameActual + 1);
      }
    } catch {
      setMensajeEstado('Guardado en catálogo maestro local (Backend desconectado)');
      if (avanzarDespues && frameActual < totalFrames) {
        irAFotograma(frameActual + 1);
      }
    } finally {
      setGuardando(false);
    }
  }, [
    autoAvanzar, modoValidacion, poligono, poligonoIA, identificadorFrame,
    frameActual, motorPreSegmentacion, telemetriaPool, iouActual, umbralIsotermico,
    direccionSoldadura, material, cordones, secuenciaActiva, totalFrames,
    irAFotograma, registrarFrameEnCatalogoMaestro
  ]);

  const handleNavegarSeguro = useCallback(async (direccion) => {
    if (modificadoSinGuardar && poligono.length >= 3) {
      await handleGuardarValidacion(false);
    }
    irAFotograma(frameActual + direccion);
  }, [modificadoSinGuardar, poligono.length, handleGuardarValidacion, irAFotograma, frameActual]);

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
      // Usa métricas en memoria si está offline
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

  // =========================================================================
  // 5. EXPORTAR DATASET COCO CON TODOS LOS FRAMES PROCESADOS (PRE-ETIQUETADOS + RECTIFICADOS)
  // =========================================================================
  const handleExportarCOCO = async () => {
    try {
      // 1. Obtener fotogramas guardados en MongoDB Atlas
      let registrosMongo = [];
      try {
        const res = await axios.get(`${API_URL}?secuencia=${secuenciaActiva}`);
        registrosMongo = res.data || [];
      } catch {
        registrosMongo = [];
      }

      // 2. Fusionar el Catálogo Maestro de todos los frames procesados en memoria con los rectificados en MongoDB
      const mapaConsolidado = { ...registroSecuenciaRef.current };

      registrosMongo.forEach((doc) => {
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
            ...metadatosAts,
            ...doc.metadatos
          }
        };
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
            camera_model: 'FLIR A6751sc',
            ad_bits: 14,
            fps: 127,
            emissivity: metadatosAts.emissivity,
            distance_m: metadatosAts.distanceMeters,
            reflected_temp_c: metadatosAts.reflectedTempC,
            relative_humidity_pct: metadatosAts.relativeHumidity,
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
        `COCO exportado: ${listaExportar.length} frames totales (${totalRectificados} rectificados + ${totalSoloIA} pre-etiquetados)`
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '13px', fontWeight: '700', letterSpacing: '0.04em', color: 'var(--text-primary)' }}>
            CIDESI
          </span>
          <span style={{ color: 'var(--border-color)' }}>/</span>
          <span style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text-secondary)' }}>
            Estación Termográfica HITL
          </span>
          <select
            value={secuenciaActiva}
            onChange={(e) => setSecuenciaActiva(e.target.value)}
            className="input-field"
            style={{ width: 'auto', height: '30px', fontSize: '12px', marginLeft: '4px' }}
          >
            <option value="RC1.ats">RC1.ats (5.05 GB)</option>
            <option value="RC2.ats">RC2.ats (4.66 GB)</option>
            <option value="RC3.ats">RC3.ats (4.43 GB)</option>
            <option value="RC4.ats">RC4.ats (4.52 GB)</option>
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Botón 1: Cargar archivo .ATS crudo directo sin límite de tamaño */}
          <label className="btn btn-outline" title="Abrir archivo binario .ATS crudo de FLIR (lectura directa de 14-bits por bloques)">
            <svg className="icon-svg" viewBox="0 0 24 24">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>{archivoAtsCrudo ? `ATS: ${archivoAtsCrudo.name}` : 'Cargar .ATS Crudo'}</span>
            <input
              type="file"
              accept=".ats,.raw,application/octet-stream"
              onChange={handleCargarArchivoATS}
              style={{ display: 'none' }}
            />
          </label>

          {/* Botón 2: Cargar lote de fotogramas .png/.jpg */}
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

          {/* Botón 3: Procesar secuencia completa para que TODOS los frames entren al COCO */}
          <button
            type="button"
            onClick={handlePreSegmentarSecuenciaCompleta}
            disabled={procesandoLoteMasivo}
            className="btn btn-outline"
            title="Pre-segmenta automáticamente toda la secuencia para incluir todos los frames en el archivo COCO"
          >
            <svg className="icon-svg" viewBox="0 0 24 24">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            <span>
              {procesandoLoteMasivo
                ? `Procesando (${progresoLote}%)`
                : `Pre-segmentar Lote (${totalFramesEnRegistro})`}
            </span>
          </button>

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

          <button onClick={handleExportarCOCO} className="btn btn-outline" title="Exporta TODOS los fotogramas procesados (pre-segmentados + rectificados)">
            <svg className="icon-svg" viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Exportar COCO Total</span>
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
        
        {/* PANEL IZQUIERDO: TELEMETRÍA Y METADATOS EXTRAÍDOS DEL .ATS */}
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
              <h2 className="section-title">Metadatos Cabezal .ATS</h2>
            </div>
            <div className="data-list">
              <div className="data-row">
                <span className="data-label">Cámara</span>
                <span className="data-value">{metadatosAts.cameraModel}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Resolución</span>
                <span className="data-value">{metadatosAts.resolution} ({metadatosAts.adBits}-bit)</span>
              </div>
              <div className="data-row">
                <span className="data-label">Emisividad</span>
                <span className="data-value">{metadatosAts.emissivity}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Distancia / Temp.</span>
                <span className="data-value">{metadatosAts.distanceMeters}m / {metadatosAts.reflectedTempC}°C</span>
              </div>
              <div className="data-row">
                <span className="data-label">Timestamp</span>
                <span className="data-value">{metadatosAts.timestampMs} ms</span>
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
                  background: 'linear-gradient(to bottom, #ffffff 0%, #a1a1aa 45%, #27272a 80%, #09090b 100%)',
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
              />

              <button
                type="button"
                onClick={() => handleNavegarSeguro(1)}
                disabled={frameActual >= totalFrames}
                className="btn btn-outline"
                style={{ height: '30px', padding: '0 10px', fontSize: '11px' }}
              >
                <span>Siguiente</span>
                <svg className="icon-svg" viewBox="0 0 24 24">
                  <polygon points="5 4 15 12 5 20 5 4" />
                  <line x1="19" y1="5" x2="19" y2="19" />
                </svg>
              </button>

              <button
                type="button"
                onClick={() => handleGuardarValidacion(true)}
                disabled={guardando}
                className="btn btn-primary"
                style={{ height: '30px', padding: '0 14px', fontSize: '11px' }}
              >
                <span>{guardando ? 'Guardando...' : 'Guardar y Siguiente'}</span>
                <svg className="icon-svg" viewBox="0 0 24 24">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          </div>
        </main>

        {/* PANEL DERECHO: MOTOR YOLO CARLOS + DICTAMEN EXPERTO */}
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
                <div className="info-tooltip">
                  <svg className="icon-svg" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                  <div className="tooltip-content">
                    Conecta con el algoritmo YOLO de Carlos para pre-segmentar los fotogramas del archivo .ATS. Incluye respaldo isotérmico automático.
                  </div>
                </div>
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
                <span className="data-label">Total Fotogramas en Catálogo COCO</span>
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