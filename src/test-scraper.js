import dotenv from 'dotenv';
import fs from 'fs';
import { checkMielUpdates } from './scraper.js';

// Cargar variables de entorno desde .env o data.env
const envPath = fs.existsSync('.env') ? '.env' : (fs.existsSync('data.env') ? 'data.env' : '.env');
dotenv.config({ path: envPath });

async function runTest() {
  const credentials = {
    usuario: process.env.MIEL_DNI,
    clave: process.env.MIEL_PASSWORD
  };

  const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';

  console.log('--- Iniciando Prueba del Scraper de MIeL ---');
  console.log(`Archivo env: ${envPath}`);
  console.log(`DNI: ${credentials.usuario ? 'Configurado' : 'NO Configurado'}`);
  console.log(`Clave: ${credentials.clave ? 'Configurada' : 'NO Configurada'}`);
  console.log(`Modo Headless (sin ventana): ${headless}`);
  console.log('---------------------------------------------');

  if (!credentials.usuario || !credentials.clave) {
    console.error('Error: Por favor, configura las variables MIEL_DNI y MIEL_PASSWORD en tu archivo .env o data.env');
    process.exit(1);
  }

  console.log('Iniciando scraper...');
  const startTime = Date.now();

  try {
    const updates = await checkMielUpdates(credentials, headless);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n=============================================');
    console.log(`Prueba completada con éxito en ${duration} segundos.`);
    console.log(`Novedades activas encontradas: ${updates.length}`);
    console.log('=============================================');

    if (updates.length > 0) {
      updates.forEach((update, index) => {
        console.log(`\n[Novedad #${index + 1}] (${update.type.toUpperCase()})`);
        console.log(`Materia:   ${update.materia}`);
        console.log(`Asunto:    ${update.asunto}`);
        console.log(`Estado/De: ${update.remitente}`);
        console.log(`Fecha:     ${update.fecha}`);
        if (update.detalle) console.log(`Detalle:   ${update.detalle}`);
        if (update.url) console.log(`URL:       ${update.url}`);
        console.log(`ID Único:  ${update.id}`);
      });
    } else {
      console.log('No se encontraron novedades nuevas ni mensajes/foros pendientes sin leer.');
    }
  } catch (error) {
    console.error('\n❌ La prueba falló con el siguiente error:');
    console.error(error.message);
    console.log('\nSi el error indica un fallo en el selector o timeout, revisa si hay una captura en la carpeta "screenshots/".');
    process.exit(1);
  }
}

runTest();
