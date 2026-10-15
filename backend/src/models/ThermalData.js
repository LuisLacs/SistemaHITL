const mongoose = require('mongoose');

const PuntoSchema = new mongoose.Schema({
  x: { type: Number, required: true },
  y: { type: Number, required: true }
}, { _id: false });

const ThermalDataSchema = new mongoose.Schema({
  frameId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  imageUrl: { 
    type: String, 
    required: true 
  },
  estado: { 
    type: String, 
    enum: ['Pendiente', 'Revisado', 'Descartado'], 
    default: 'Pendiente' 
  },
  tipoValidacion: {
    type: String,
    enum: ['Binaria', 'Poligono', 'Ninguna'],
    default: 'Ninguna'
  },
  aprobadoBinario: {
    type: Boolean,
    default: null
  },
  // Pre-segmentación generada por el algoritmo automático
  poligonoPreEtiquetado: [PuntoSchema],
  // Segmentación final aprobada o corregida por el experto humano
  poligono: [PuntoSchema],
  metadatos: {
    tempMaxima: { type: Number, default: 0 },
    tempPromedio: { type: Number, default: 0 },
    areaPixeles: { type: Number, default: 0 },
    perimetroPixeles: { type: Number, default: 0 },
    incertidumbreAlgoritmo: { type: Number, default: 0 },
    iouSimilitud: { type: Number, default: 100 }, // % de coincidencia IA vs Experto
    tiempoValidacionSeg: { type: Number, default: 0 },
    umbralRadiometrico: { type: Number, default: 0 },
    direccionSoldadura: { type: String, default: 'Izquierda a Derecha' },
    material: { type: String, default: 'Acero Inoxidable 304L' },
    numeroCordones: { type: Number, default: 1 }
  },
  validadorId: { 
    type: String, 
    required: false 
  },
  fechaValidacion: { 
    type: Date 
  }
}, { timestamps: true });

module.exports = mongoose.model('ThermalData', ThermalDataSchema);