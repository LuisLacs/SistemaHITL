require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Sequelize } = require('sequelize');
const pg = require('pg'); // <-- Necesario para que Vercel empaquete PostgreSQL
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();

// Middlewares
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '15mb' }));

// 1. Conexión a PostgreSQL (Sequelize con variables separadas y dialectModule explícito)
const sequelize = new Sequelize(
  process.env.DB_POSTGRES_NAME,
  process.env.DB_POSTGRES_USER,
  process.env.DB_POSTGRES_PASS,
  {
    host: process.env.DB_POSTGRES_HOST,
    dialect: 'postgres',
    dialectModule: pg, // <-- Soluciona el error 500 en Vercel
    logging: false,
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    }
  }
);

// Importar modelos
const User = require('./models/User')(sequelize);

// 2. Conexión a MongoDB (Mongoose)
let mongoConnected = false;
const connectMongo = async () => {
  if (mongoConnected || mongoose.connection.readyState === 1) return;
  try {
    await mongoose.connect(process.env.DB_MONGO_URI);
    mongoConnected = true;
    console.log('🟢 MongoDB conectado correctamente.');
  } catch (error) {
    console.error('🔴 Error conectando a MongoDB:', error);
  }
};

// Asegurar conexión a bases de datos en cada petición serverless de Vercel
let pgSynced = false;
app.use(async (req, res, next) => {
  try {
    await connectMongo();
    if (!pgSynced) {
      await sequelize.authenticate();
      await sequelize.sync();
      pgSynced = true;
    }
    next();
  } catch (error) {
    console.error('Error conectando bases de datos:', error);
    next();
  }
});

// Ruta raíz y ruta de salud para verificar que el servidor está vivo en Vercel
app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'API HITL - CIDESI funcionando correctamente en Vercel' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'API HITL funcionando correctamente' });
});

// Ruta para Registrar un Nuevo Usuario Experto
app.post('/api/auth/register', async (req, res) => {
  try {
    const { nombre, email, password } = req.body;

    const userExists = await User.findOne({ where: { email } });
    if (userExists) {
      return res.status(400).json({ error: 'Este correo ya está registrado en el sistema.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await User.create({
      nombre,
      email,
      password: hashedPassword
    });

    // Generar también el token al registrarse para entrada directa
    const token = jwt.sign(
      { id: newUser.id, rol: newUser.rol },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.status(201).json({
      message: 'Experto registrado exitosamente',
      token,
      usuario: {
        id: newUser.id,
        nombre: newUser.nombre,
        email: newUser.email,
        rol: newUser.rol
      }
    });
  } catch (error) {
    console.error('Error en el registro:', error);
    res.status(500).json({ error: 'Error interno del servidor al registrar.' });
  }
});

// Ruta para Iniciar Sesión (Login)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }

    const token = jwt.sign(
      { id: user.id, rol: user.rol },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.status(200).json({
      message: 'Inicio de sesión exitoso',
      token,
      usuario: {
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        rol: user.rol
      }
    });
  } catch (error) {
    console.error('Error en el login:', error);
    res.status(500).json({ error: 'Error interno del servidor al iniciar sesión.' });
  }
});

// Rutas de Anotaciones Termográficas (MongoDB)
const annotationRoutes = require('./routes/annotations');
app.use('/api/annotations', annotationRoutes);

// Solo levantar el puerto con app.listen cuando estás en tu computadora local
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
  });
}

module.exports = app;