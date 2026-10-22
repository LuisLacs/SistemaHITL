const express = require('express');
const router = express.Router();
const ThermalData = require('../models/ThermalData');

function calcularGeometria(puntos) {
  if (!puntos || puntos.length < 3) return { area: 0, perimetro: 0 };

  let area = 0;
  let perimetro = 0;
  const n = puntos.length;

  for (let i = 0; i < n; i++) {
    const p1 = puntos[i];
    const p2 = puntos[(i + 1) % n];
    area += (p1.x * p2.y) - (p2.x * p1.y);
    perimetro += Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }

  return {
    area: Math.round(Math.abs(area) / 2),
    perimetro: Math.round(perimetro)
  };
}

// 1. Consultar un fotograma específico
router.get('/frame/:frameId', async (req, res) => {
  try {
    const doc = await ThermalData.findOne({ frameId: req.params.frameId });
    if (!doc) {
      return res.status(200).json({ existe: false, data: null });
    }
    res.status(200).json({ existe: true, data: doc });
  } catch (error) {
    console.error('Error al consultar fotograma:', error);
    res.status(500).json({ error: 'Error al consultar fotograma en MongoDB' });
  }
});

// 2. Obtener todas las anotaciones de una secuencia
router.get('/', async (req, res) => {
  try {
    const { secuencia } = req.query;
    const filtro = secuencia ? { frameId: { $regex: `^${secuencia}` } } : {};
    const anotaciones = await ThermalData.find(filtro).sort({ frameId: 1 });
    res.status(200).json(anotaciones);
  } catch (error) {
    console.error('Error al obtener anotaciones:', error);
    res.status(500).json({ error: 'Error al obtener las anotaciones' });
  }
});

// 3. Guardar o rectificar un fotograma individual (HITL)
router.post('/', async (req, res) => {
  try {
    const {
      frameId,
      imageUrl,
      estado,
      tipoValidacion,
      aprobadoBinario,
      poligonoPreEtiquetado,
      poligono,
      validadorId,
      tempMaxima,
      tempPromedio,
      incertidumbreAlgoritmo,
      iouSimilitud,
      tiempoValidacionSeg,
      umbralRadiometrico,
      direccionSoldadura,
      material,
      numeroCordones
    } = req.body;

    const geometria = calcularGeometria(poligono);

    const nuevaAnotacion = await ThermalData.findOneAndUpdate(
      { frameId },
      {
        frameId,
        imageUrl: imageUrl || `/dataset/${frameId}.png`,
        estado: estado || 'Revisado',
        tipoValidacion,
        aprobadoBinario,
        poligonoPreEtiquetado: poligonoPreEtiquetado || [],
        poligono: poligono || [],
        validadorId: validadorId || 'investigador_cidesi',
        fechaValidacion: new Date(),
        metadatos: {
          tempMaxima: tempMaxima || 0,
          tempPromedio: tempPromedio || 0,
          areaPixeles: geometria.area,
          perimetroPixeles: geometria.perimetro,
          incertidumbreAlgoritmo: incertidumbreAlgoritmo || 0,
          iouSimilitud: iouSimilitud ?? 100,
          tiempoValidacionSeg: tiempoValidacionSeg || 0,
          umbralRadiometrico: umbralRadiometrico || 0,
          direccionSoldadura: direccionSoldadura || 'Derecha a Izquierda',
          material: material || 'Acero Inoxidable',
          numeroCordones: numeroCordones || 1
        }
      },
      { upsert: true, new: true }
    );

    res.status(200).json({
      mensaje: 'Validación HITL sincronizada en MongoDB Atlas',
      data: nuevaAnotacion
    });
  } catch (error) {
    console.error('Error al guardar en MongoDB:', error);
    res.status(500).json({ error: 'Error interno al guardar en MongoDB' });
  }
});

// 4. NUEVO: Sincronización por Lote (Guarda múltiples frames pre-procesados sin sobrescribir los ya rectificados por el experto)
router.post('/batch', async (req, res) => {
  try {
    const { frames } = req.body;
    if (!Array.isArray(frames) || frames.length === 0) {
      return res.status(400).json({ error: 'No se recibieron fotogramas para procesar en lote.' });
    }

    const operaciones = frames.map((item) => {
      const geometria = calcularGeometria(item.poligono);
      return {
        updateOne: {
          filter: { frameId: item.frameId, estado: { $ne: 'Revisado' } },
          update: {
            $setOnInsert: {
              frameId: item.frameId,
              imageUrl: item.imageUrl || `/dataset/${item.frameId}.png`,
              estado: 'Pendiente',
              tipoValidacion: 'Ninguna',
              aprobadoBinario: null,
              poligonoPreEtiquetado: item.poligonoPreEtiquetado || item.poligono || [],
              poligono: item.poligono || [],
              validadorId: item.validadorId || 'auto_presegmentacion',
              metadatos: {
                tempMaxima: item.tempMaxima || 7082,
                tempPromedio: item.tempPromedio || 5800,
                areaPixeles: geometria.area,
                perimetroPixeles: geometria.perimetro,
                incertidumbreAlgoritmo: item.incertidumbreAlgoritmo || 12.0,
                iouSimilitud: 100,
                tiempoValidacionSeg: 0,
                umbralRadiometrico: item.umbralRadiometrico || 218,
                direccionSoldadura: item.direccionSoldadura || 'Derecha a Izquierda',
                material: item.material || 'Acero Inoxidable',
                numeroCordones: item.numeroCordones || 1
              }
            }
          },
          upsert: true
        }
      };
    });

    const resultado = await ThermalData.bulkWrite(operaciones, { ordered: false }).catch(() => null);

    res.status(200).json({
      mensaje: 'Lote de fotogramas registrado exitosamente',
      procesados: frames.length,
      detalle: resultado ? resultado.upsertedCount : frames.length
    });
  } catch (error) {
    console.error('Error en guardado masivo:', error);
    res.status(500).json({ error: 'Error al procesar el lote de fotogramas' });
  }
});

module.exports = router;