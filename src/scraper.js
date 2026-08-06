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

    // Extraer las materias y sus secciones con notificaciones desde el dashboard
    const materias = await page.evaluate(() => {
      const bloques = Array.from(document.querySelectorAll('.materia-bloque'));
      return bloques.map(bloque => {
        const tituloEl = bloque.querySelector('.materia-titulo');
        const detalleEl = bloque.querySelector('.materia-descripcion div.w3-small');
        
        let nombre = tituloEl ? tituloEl.textContent.trim() : 'Materia sin nombre';
        if (detalleEl) {
          const detalles = detalleEl.textContent.trim()
            .replace(/\s+/g, ' ')
            .replace(' - Alumno/a', '')
            .trim();
          if (detalles) {
            nombre += ` (${detalles})`;
          }
        }

        // Buscar todos los enlaces dentro del bloque de la materia
        const enlaces = Array.from(bloque.querySelectorAll('a[href]'));
        const secciones = [];

        enlaces.forEach(enlace => {
          const href = enlace.href.toLowerCase();
          
          // Identificar el tipo de sección por la URL
          let tipo = null;
          if (href.includes('/mensajeria/')) tipo = 'mensajeria';
          else if (href.includes('/foro/')) tipo = 'foro';
          else if (href.includes('/contenido/') || href.includes('/material/')) tipo = 'contenido';
          else if (href.includes('/evaluacion/')) tipo = 'evaluacion';
          else if (href.includes('/portafolio/') || href.includes('/trabajo/')) tipo = 'portafolio';

          if (tipo) {
            // Verificar si hay una notificación (badge rojo, número > 0, clase 'notificacion', etc.)
            // Revisamos el enlace mismo, y sus contenedores cercanos
            const badge = enlace.querySelector('.w3-badge, .badge, .notificacion, .w3-red, [style*="color: red"]') ||
                          (enlace.parentElement && enlace.parentElement.querySelector('.w3-badge, .badge, .notificacion, .w3-red'));
            
            // Ante la duda de si MIeL siempre pone notificaciones visuales, 
            // agregamos TODAS las secciones para revisarlas a fondo, sin depender de la burbuja.
            secciones.push({
              type: tipo,
              url: enlace.href
            });
          }
        });

        // Eliminar secciones duplicadas por tipo (por si hay múltiples links a la misma sección)
        const uniqueSecciones = [];
        const seenTypes = new Set();
        for (const sec of secciones) {
          if (!seenTypes.has(sec.type)) {
            seenTypes.add(sec.type);
            uniqueSecciones.push(sec);
          }
        }

        return {
          name: nombre,
          secciones: uniqueSecciones
        };
      }).filter(m => m.secciones.length > 0);
    });

    let totalNovedades = 0;
    const allUpdates = [];

    console.log(`Se encontraron novedades en ${materias.length} materias.`);

    // Recorrer cada materia y sus secciones con alertas
    for (const materia of materias) {
      for (const seccion of materia.secciones) {
        console.log(`[${materia.name}] Revisando sección: ${seccion.type}...`);
        try {
          await page.goto(seccion.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          
          const comisionIdMatch = seccion.url.match(/comision\/(\d+)/);
          const comisionId = comisionIdMatch ? comisionIdMatch[1] : 'unknown';

          // Extraer novedades dependiendo del tipo de sección
          const novedades = await page.evaluate(({ cId, sType }) => {
            const rows = Array.from(document.querySelectorAll('table tbody tr, ul li.mensaje, .mensaje-item, .foro-item, .evaluacion-item, .contenido-item'));
            const unread = [];

            rows.forEach((row, index) => {
              // Para mensajería, usamos las reglas específicas
              if (sType === 'mensajeria') {
                const isUnreadClass = row.classList.contains('mensaje-no-leido');
                const mailIcon = row.querySelector('.material-icons');
                const isUnreadIcon = mailIcon && (mailIcon.textContent.trim() === 'mail' || mailIcon.textContent.trim() === 'email' || mailIcon.textContent.trim() === 'markunread');
                const botonLeido = row.querySelector('.botonLeido');
                const isUnreadState = botonLeido && botonLeido.getAttribute('data-estado') === '0';
                const isBold = row.querySelector('strong, .w3-bold') !== null || window.getComputedStyle(row).fontWeight === 'bold' || window.getComputedStyle(row).fontWeight === '700';

                if (isUnreadClass || isUnreadIcon || isUnreadState || isBold) {
                  const cells = Array.from(row.querySelectorAll('td'));
                  const fecha = cells[0] ? cells[0].textContent.trim().replace(/\s+/g, ' ') : 'Reciente';
                  const remitente = cells[1] ? cells[1].textContent.trim().replace(/\s+/g, ' ') : 'Profesor';
                  const asunto = cells[3] ? cells[3].textContent.trim().replace(/\s+/g, ' ') : 'Sin asunto';
                  
                  unread.push({
                    id: `${cId}_msg_${index}_${remitente.substring(0,5)}_${fecha.replace(/\//g, '-')}`,
                    type: sType,
                    remitente,
                    asunto,
                    fecha
                  });
                }
              } else {
                // Para Foros, Contenido, Evaluaciones, Portafolio:
                // Como ya verificamos en el dashboard que HAY una novedad, extraemos las primeras filas
                // o las que tengan clase de "nuevo" / negrita.
                const isNew = row.classList.contains('nuevo') || row.classList.contains('unread') || row.querySelector('.w3-red, .badge, strong, .w3-bold, i.w3-text-red') !== null || index === 0;
                
                if (isNew && index < 3) { // Limitamos a 3 para no saturar si extraemos por error
                  const texts = Array.from(row.querySelectorAll('td, span, div, h2, h3, a'))
                                     .map(c => c.textContent.trim().replace(/\s+/g, ' '))
                                     .filter(t => t.length > 3);
                  
                  // Intentamos deducir el título y autor/fecha
                  const asunto = texts[0] || 'Nueva actualización';
                  const remitente = texts[1] || texts[2] || 'Sistema MIeL';
                  const fecha = texts.find(t => t.match(/\d{2}\/\d{2}\/\d{2,4}/)) || 'Reciente';

                  unread.push({
                    id: `${cId}_${sType}_${index}_${asunto.substring(0,8).replace(/\s+/g, '')}`,
                    type: sType,
                    remitente,
                    asunto,
                    fecha
                  });
                }
              }
            });

            return unread;
          }, { cId: comisionId, sType: seccion.type });

          if (novedades.length > 0) {
            console.log(`  ¡Encontrados ${novedades.length} novedades en ${seccion.type}!`);
            totalNovedades += novedades.length;
            
            novedades.forEach(nov => {
              allUpdates.push({
                ...nov,
                materia: materia.name
              });
            });
          }
        } catch (err) {
          console.error(`Error al revisar la sección ${seccion.type} de ${materia.name}:`, err.message);
        }
      }
    }

    console.log(`Verificación completada. Encontradas: ${totalNovedades} novedades.`);
    return allUpdates;

  } catch (error) {
    console.error('Error durante la ejecución del scraper:', error);
    // Capturar pantalla de error general
    const errorScreenshot = path.join(SCREENSHOTS_DIR, 'general_error.png');
    await page.screenshot({ path: errorScreenshot }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}
