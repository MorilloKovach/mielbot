import fs from 'fs';
import path from 'path';

const DB_FILE = path.join(process.cwd(), 'database.json');

// Cargar la base de datos
export function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error al cargar la base de datos, usando una nueva:', error);
  }
  return { notifiedIds: [] };
}

// Guardar la base de datos
export function saveDatabase(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (error) {
    console.error('Error al guardar la base de datos:', error);
  }
}

// Verificar si un ID ya fue notificado
export function hasBeenNotified(id) {
  const db = loadDatabase();
  return db.notifiedIds.includes(id);
}

// Marcar un ID como notificado
export function markAsNotified(id) {
  const db = loadDatabase();
  if (!db.notifiedIds.includes(id)) {
    db.notifiedIds.push(id);
    // Limitar el historial de notificaciones para evitar que el archivo crezca indefinidamente (ej. guardar los últimos 1000)
    if (db.notifiedIds.length > 1000) {
      db.notifiedIds.shift();
    }
    saveDatabase(db);
  }
}
