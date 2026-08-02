import playwright from 'playwright';
import path from 'path';
import fs from 'fs';

// Asegurar que exista la carpeta de capturas de pantalla
const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Función principal del scraper para verificar novedades en MIeL.
 * @param {Object} credentials - Objeto con usuario y clave.
 * @param {boolean} headless - Si debe ejecutarse en segundo plano.
 * @returns {Promise<Array>} - Lista de novedades encontradas.
 */
export async function checkMielUpdates(credentials, headless = true) {
  const { usuario, clave } = credentials;
  if (!usuario || !clave) {
    throw new Error('Credenciales inválidas: DNI y clave son requeridos.');
  }

  const browserType = process.env.PLAYWRIGHT_BROWSER_TYPE || 'chromium';
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || null;

  if (!['chromium', 'firefox', 'webkit'].includes(browserType)) {
    throw new Error(`Tipo de navegador inválido en .env: ${browserType}`);
  }

  console.log(`Lanzando navegador (${browserType})...`);
  const launchOptions = {
    headless: headless,
    args: browserType === 'chromium' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []
  };

  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  const browser = await playwright[browserType].launch(launchOptions);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'es-AR'
  });

  const page = await context.newPage();
  const updates = [];

  try {
    console.log('Navegando a la página de login de MIeL...');
    await page.goto('https://miel.unlam.edu.ar', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Rellenar formulario de login
    console.log('Ingresando credenciales...');
    await page.fill('input[name="usuario"]', usuario);
    await page.fill('input[name="clave"]', clave);
    
    // Enviar el formulario presionando Enter y esperar la navegación concurrentemente
    console.log('Enviando formulario...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).catch(() => {
        // Ignorar el timeout si la navegación ya se resolvió por otra vía
      }),
      page.keyboard.press('Enter')
    ]);

    console.log('Verificando estado post-login...');
    // Esperar a que aparezca o un bloque de materia (éxito) o un mensaje de error (fallo)
    await page.waitForSelector('.materia-bloque, .w3-panel.w3-red, .error, .alert', { timeout: 30000 }).catch(() => {
      console.log('Nota: No se detectó selector de control post-login inmediatamente.');
    });

    // Verificar si el inicio de sesión falló
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl === 'https://miel.unlam.edu.ar/') {
      // Capturar pantalla si falla el login
      const errorScreenshot = path.join(SCREENSHOTS_DIR, 'login_failed.png');
      await page.screenshot({ path: errorScreenshot });
      
      // Buscar mensajes de error comunes en la página
      const errorText = await page.evaluate(() => {
        const alert = document.querySelector('.w3-panel.w3-red, .error, .alert');
        return alert ? alert.textContent.trim() : 'Usuario o clave incorrectos o página colapsada.';
      });

      throw new Error(`Fallo en el inicio de sesión. Detalle: ${errorText} (Captura guardada en ${errorScreenshot})`);
    }

    console.log('Inicio de sesión exitoso. Url actual:', currentUrl);

    // Esperar a que los elementos del portfolio (materias) estén visibles
    await page.waitForSelector('.materia-bloque', { timeout: 30000 }).catch(() => {
      console.log('Advertencia: No se encontraron bloques de materias (.materia-bloque). Procediendo...');
    });

    // Extraer las materias y sus links de mensajería desde el dashboard
    const materias = await page.evaluate(() => {
      const bloques = Array.from(document.querySelectorAll('.materia-bloque'));
      return bloques.map(bloque => {
        const tituloEl = bloque.querySelector('.materia-titulo');
        const detalleEl = bloque.querySelector('.materia-descripcion div.w3-small');
        
        let nombre = tituloEl ? tituloEl.textContent.trim() : 'Materia sin nombre';
        if (detalleEl) {
          // Limpiar detalles como "Alumno/a" o espacios extras
          const detalles = detalleEl.textContent.trim()
            .replace(/\s+/g, ' ')
            .replace(' - Alumno/a', '')
            .trim();
          if (detalles) {
            nombre += ` (${detalles})`;
          }
        }

        const mensajesLink = bloque.querySelector('a[href*="/mensajeria/entrada/comision/"]');
        return {
          name: nombre,
          url: mensajesLink ? mensajesLink.href : null
        };
      }).filter(m => m.url !== null);
    });

    console.log(`Se encontraron ${materias.length} materias con mensajería activa en tu portfolio.`);

    // Recorrer cada materia para revisar novedades
    for (const materia of materias) {
      console.log(`Revisando mensajes de: ${materia.name}...`);
      try {
        // Navegar directamente a la mensajería de la materia
        await page.goto(materia.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        
        // Extraer ID de la comisión desde la URL
        const comisionIdMatch = materia.url.match(/comision\/(\d+)/);
        const comisionId = comisionIdMatch ? comisionIdMatch[1] : 'unknown';

        // Buscar mensajes no leídos
        const messages = await page.evaluate((cId) => {
          const rows = Array.from(document.querySelectorAll('table tbody tr, ul li.mensaje, .mensaje-item'));
          const unread = [];

          rows.forEach((row, index) => {
            // Buscar indicador de no leído (clase 'mensaje-no-leido', icono 'markunread', data-estado="0" o texto en negrita)
            const isUnreadClass = row.classList.contains('mensaje-no-leido');
            
            const mailIcon = row.querySelector('.material-icons');
            const isUnreadIcon = mailIcon && (
              mailIcon.textContent.trim() === 'mail' || 
              mailIcon.textContent.trim() === 'email' || 
              mailIcon.textContent.trim() === 'markunread'
            );
            
            const botonLeido = row.querySelector('.botonLeido');
            const isUnreadState = botonLeido && botonLeido.getAttribute('data-estado') === '0';
            
            const isBold = row.querySelector('strong, .w3-bold') !== null || 
                           window.getComputedStyle(row).fontWeight === 'bold' || 
                           window.getComputedStyle(row).fontWeight === '700';

            if (isUnreadClass || isUnreadIcon || isUnreadState || isBold) {
              const cells = Array.from(row.querySelectorAll('td'));
              const fecha = cells[0] ? cells[0].textContent.trim().replace(/\s+/g, ' ') : 'Reciente';
              const remitente = cells[1] ? cells[1].textContent.trim().replace(/\s+/g, ' ') : 'Docente/Sistema';
              const asunto = cells[3] ? cells[3].textContent.trim().replace(/\s+/g, ' ') : 'Sin asunto';
              
              const msgId = `${cId}_msg_${index}_${remitente.substring(0, 5)}_${fecha.replace(/\//g, '-')}`;

              unread.push({
                id: msgId,
                type: 'message',
                remitente,
                asunto,
                fecha
              });
            }
          });

          return unread;
        }, comisionId);

        if (messages.length > 0) {
          console.log(`  ¡Encontrados ${messages.length} mensajes no leídos!`);
          for (const msg of messages) {
            updates.push({
              materia: materia.name,
              ...msg
            });
          }
        }

        // --- OPCIONAL: Verificar Foro o Novedades ---
        // Podemos añadir aquí raspado de Foros de forma similar si se desea.
        
      } catch (materiaError) {
        console.error(`Error al revisar la materia ${materia.name}:`, materiaError);
        // Capturar pantalla para depuración
        const mScreenshot = path.join(SCREENSHOTS_DIR, `error_${materia.name.replace(/[^a-zA-Z0-9]/g, '_')}.png`);
        await page.screenshot({ path: mScreenshot }).catch(() => {});
      }
    }

  } catch (error) {
    console.error('Error durante la ejecución del scraper:', error);
    // Capturar pantalla de error general
    const errorScreenshot = path.join(SCREENSHOTS_DIR, 'general_error.png');
    await page.screenshot({ path: errorScreenshot }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }

  return updates;
}
