import fs from 'fs';
import path from 'path';

const DB_FILE = path.join(process.cwd(), 'database.json');
const MAX_HISTORY = 5000;

function normalizeDb(raw = {}) {
  return {
    notifiedIds: Array.isArray(raw.notifiedIds) ? raw.notifiedIds : [],
    seededSections: Array.isArray(raw.seededSections) ? raw.seededSections : [],
    lastCheckTime: raw.lastCheckTime || null,
    lastSubjects: Array.isArray(raw.lastSubjects) ? raw.lastSubjects : []
  };
}

// Cargar la base de datos
export function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return normalizeDb(JSON.parse(data));
    }
  } catch (error) {
    console.error('Error al cargar la base de datos, usando una nueva:', error);
  }
  return normalizeDb();
}

// Guardar la base de datos
export function saveDatabase(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(normalizeDb(db), null, 2), 'utf8');
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
  markMultipleAsNotified([id]);
}

// Marcar múltiples IDs como notificados en una sola operación de disco
export function markMultipleAsNotified(ids = []) {
  if (!ids.length) return;
  const db = loadDatabase();
  let changed = false;

  for (const id of ids) {
    if (id && !db.notifiedIds.includes(id)) {
      db.notifiedIds.push(id);
      changed = true;
    }
  }

  if (changed) {
    if (db.notifiedIds.length > MAX_HISTORY) {
      db.notifiedIds = db.notifiedIds.slice(-MAX_HISTORY);
    }
    saveDatabase(db);
  }
}

// Verificar si una sección ya tuvo su relevamiento base inicial
export function isSectionSeeded(sectionKey) {
  const db = loadDatabase();
  return db.seededSections.includes(sectionKey);
}

// Registrar el estado base inicial de una sección para no spamear historial viejo
export function seedSectionItems(sectionKey, ids = []) {
  const db = loadDatabase();
  if (!db.seededSections.includes(sectionKey)) {
    db.seededSections.push(sectionKey);
  }
  for (const id of ids) {
    if (id && !db.notifiedIds.includes(id)) {
      db.notifiedIds.push(id);
    }
  }
  if (db.notifiedIds.length > MAX_HISTORY) {
    db.notifiedIds = db.notifiedIds.slice(-MAX_HISTORY);
  }
  saveDatabase(db);
}

// Guardar metadatos de la última verificación exitosa
export function saveCheckMetadata({ lastCheckTime, lastSubjects }) {
  const db = loadDatabase();
  if (lastCheckTime) db.lastCheckTime = lastCheckTime;
  if (Array.isArray(lastSubjects)) db.lastSubjects = lastSubjects;
  saveDatabase(db);
}
