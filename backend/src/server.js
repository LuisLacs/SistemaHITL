require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Sequelize } = require('sequelize');
const mongoose = require('mongoose');

const app = express();



// Middlewares
app.use(cors());
app.use(express.json());

// 1. Conexión a PostgreSQL (Sequelize con variables separadas)
const sequelize = new Sequelize(
  process.env.DB_POSTGRES_NAME,
  process.env.DB_POSTGRES_USER,
  process.env.DB_POSTGRES_PASS,
  {
    host: process.env.DB_POSTGRES_HOST,
    dialect: 'postgres',
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
const connectMongo = async () => {
  try {
    await mongoose.connect(process.env.DB_MONGO_URI);
    console.log('🟢 MongoDB conectado correctamente.');
  } catch (error) {
    console.error('🔴 Error conectando a MongoDB:', error);
  }
};

// Rutas de prueba
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'API HITL funcionando correctamente' });
});
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Ruta para Registrar un Nuevo Usuario Experto
app.post('/api/auth/register', async (req, res) => {
  try {
    // 1. Recibir los datos del cliente
    const { nombre, email, password } = req.body;

    // 2. Verificar si el usuario ya existe en PostgreSQL
    const userExists = await User.findOne({ where: { email } });
    if (userExists) {
      return res.status(400).json({ error: 'Este correo ya está registrado en el sistema.' });
    }

    // 3. Encriptar la contraseña (NUNCA guardar contraseñas en texto plano)
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 4. Crear el usuario en la base de datos
    const newUser = await User.create({
      nombre,
      email,
      password: hashedPassword
    });

    // 5. Responder con éxito (sin enviar la contraseña de vuelta)
    res.status(201).json({ 
      message: 'Experto registrado exitosamente', 
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

// Inicialización del servidor
const PORT = process.env.PORT || 3000;
// Ruta para Iniciar Sesión (Login)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Verificar si el usuario existe
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    // 2. Comparar la contraseña ingresada con el hash de la base de datos
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }

    // 3. Generar el Token JWT
    const token = jwt.sign(
      { id: user.id, rol: user.rol }, // Datos que viajan dentro del token (Payload)
      process.env.JWT_SECRET,         // Tu llave secreta del archivo .env
      { expiresIn: '8h' }             // Tiempo de expiración de la sesión
    );

    // 4. Responder con el token y los datos del usuario
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
const annotationRoutes = require('./routes/annotations');
app.use('/api/annotations', annotationRoutes);

const startServer = async () => {
  try {
    // Autenticar Postgres
    await sequelize.authenticate();
    console.log('🟢 PostgreSQL conectado correctamente.');

    // Sincronizar modelos con la base de datos
    await sequelize.sync({ alter: true });
    console.log('🟢 Tablas de PostgreSQL sincronizadas correctamente.');
    
    // Conectar Mongo
    await connectMongo();

    // Levantar Express
    app.listen(PORT, () => {
      console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('🔴 Error crítico al iniciar el servidor:', error);
  }
};

startServer();
module.exports = app;