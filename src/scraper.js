import playwright from 'playwright';
import path from 'path';
import fs from 'fs';
import { isSectionSeeded, seedSectionItems, hasBeenNotified, saveCheckMetadata } from './database.js';

// Asegurar que exista la carpeta de capturas de pantalla
const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// Cantidad de secciones que se consultan en paralelo mediante fetch() dentro de la sesión autenticada
const FETCH_CONCURRENCY = 4;

/**
 * Lanza el navegador con fallback automático al navegador integrado de Playwright
 * si PLAYWRIGHT_EXECUTABLE_PATH no existe o falla al iniciar (evita error kill ESRCH en la nube).
 */
async function launchBrowserWithFallback(browserType, headless, executablePath) {
  const baseArgs = browserType === 'chromium'
    ? [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    : [];

  if (executablePath) {
    if (fs.existsSync(executablePath)) {
      try {
        console.log(`Lanzando navegador (${browserType}) desde ruta personalizada: ${executablePath}...`);
        return await playwright[browserType].launch({
          headless,
          executablePath,
          args: baseArgs
        });
      } catch (err) {
        console.warn(`⚠️ Falló el lanzamiento con PLAYWRIGHT_EXECUTABLE_PATH (${executablePath}): ${err.message}`);
        console.log('Reintentando automáticamente con el navegador integrado de Playwright...');
      }
    } else {
      console.warn(`⚠️ La ruta PLAYWRIGHT_EXECUTABLE_PATH (${executablePath}) no existe en este sistema. Usando navegador integrado de Playwright...`);
    }
  }

  console.log(`Lanzando navegador integrado (${browserType})...`);
  return await playwright[browserType].launch({
    headless,
    args: baseArgs
  });
}

/**
 * Función principal del scraper para verificar novedades en MIeL.
 * Optimizada: Inicia sesión una sola vez, bloquea recursos pesados (imágenes/fuentes/CSS)
 * y consulta todas las secciones en paralelo vía fetch() + DOMParser dentro de la sesión activa.
 *
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

  const startTime = Date.now();
  const browser = await launchBrowserWithFallback(browserType, headless, executablePath);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'es-AR'
  });

  const page = await context.newPage();

  // Bloquear imágenes, fuentes, multimedia y hojas de estilo para acelerar la carga y ahorrar RAM en GCP
  await page.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
      return route.abort();
    }
    return route.continue();
  });

  try {
    console.log('Navegando a la página de login de MIeL...');
    await page.goto('https://miel.unlam.edu.ar', { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Rellenar formulario de login
    console.log('Ingresando credenciales...');
    await page.fill('input[name="usuario"]', usuario);
    await page.fill('input[name="clave"]', clave);

    // Enviar el formulario presionando Enter y esperar la navegación concurrentemente
    console.log('Enviando formulario...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
      page.keyboard.press('Enter')
    ]);

    await page.waitForSelector('.materia-bloque, .w3-panel.w3-red, .error, .alert', { timeout: 25000 }).catch(() => {
      console.log('Nota: No se detectó selector de control post-login inmediatamente.');
    });

    // Verificar si el inicio de sesión falló
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl === 'https://miel.unlam.edu.ar/') {
      const errorScreenshot = path.join(SCREENSHOTS_DIR, 'login_failed.png');
      await page.screenshot({ path: errorScreenshot });

      const errorText = await page.evaluate(() => {
        const alert = document.querySelector('.w3-panel.w3-red, .error, .alert');
        return alert ? alert.textContent.trim() : 'Usuario o clave incorrectos o página colapsada.';
      });

      throw new Error(`Fallo en el inicio de sesión. Detalle: ${errorText} (Captura guardada en ${errorScreenshot})`);
    }

    console.log(`Inicio de sesión exitoso en ${((Date.now() - startTime) / 1000).toFixed(1)}s. Extrayendo materias...`);

    // Extraer las materias y sus secciones desde el dashboard
    const materias = await page.evaluate(() => {
      const bloques = Array.from(document.querySelectorAll('.materia-bloque'));
      return bloques.map(bloque => {
        const comisionId = bloque.getAttribute('data-id') || 'unknown';
        const tituloEl = bloque.querySelector('.materia-titulo');
        const detalleEl = bloque.querySelector('.materia-descripcion div.w3-small');

        let nombre = tituloEl ? tituloEl.textContent.trim() : 'Materia sin nombre';
        if (detalleEl) {
          const codigoDetalle = detalleEl.textContent.trim()
            .replace(/\s+/g, ' ')
            .replace(' - Alumno/a', '')
            .trim();
          if (codigoDetalle) {
            nombre += ` (${codigoDetalle})`;
          }
        }

        const enlaces = Array.from(bloque.querySelectorAll('a[href]'));
        const secciones = [];

        enlaces.forEach(enlace => {
          const href = enlace.href.toLowerCase();

          let tipo = null;
          if (href.includes('/mensajeria/')) tipo = 'mensajeria';
          else if (href.includes('/foro')) tipo = 'foro';
          else if (href.includes('/contenido/') || href.includes('/material/')) tipo = 'contenido';
          else if (href.includes('/evaluacion/')) tipo = 'evaluacion';
          else if (href.includes('/portafolio/') || href.includes('/trabajo/')) tipo = 'portafolio';
          else if (href.includes('/encuesta/')) tipo = 'encuesta';

          if (tipo) {
            const badgeEl = enlace.querySelector('.w3-badge, .badge, .notificacion, .w3-red') ||
                            (enlace.parentElement && enlace.parentElement.querySelector('.w3-badge, .badge, .notificacion, .w3-red'));
            const badgeCount = badgeEl ? (parseInt(badgeEl.textContent.trim(), 10) || 1) : 0;

            secciones.push({
              type: tipo,
              url: enlace.href,
              badgeCount
            });
          }
        });

        const uniqueSecciones = [];
        const seenTypes = new Set();
        for (const sec of secciones) {
          if (!seenTypes.has(sec.type)) {
            seenTypes.add(sec.type);
            uniqueSecciones.push(sec);
          }
        }

        return {
          comisionId,
          name: nombre,
          secciones: uniqueSecciones
        };
      }).filter(m => m.secciones.length > 0);
    });

    // Construir la lista plana de tareas a consultar por fetch() en lotes paralelos
    const tasks = [];
    const subjectsSummary = [];

    for (const materia of materias) {
      const matSummary = {
        comisionId: materia.comisionId,
        name: materia.name,
        badges: {}
      };

      for (const seccion of materia.secciones) {
        if (seccion.badgeCount > 0) {
          matSummary.badges[seccion.type] = seccion.badgeCount;
        }
        const comisionIdMatch = seccion.url.match(/comision\/(\d+)/);
        const comisionId = comisionIdMatch ? comisionIdMatch[1] : materia.comisionId;

        tasks.push({
          materiaName: materia.name,
          comisionId,
          sectionKey: `${comisionId}_${seccion.type}`,
          type: seccion.type,
          url: seccion.url,
          badgeCount: seccion.badgeCount
        });
      }

      subjectsSummary.push(matSummary);
    }

    // Agregar también la tarea de Novedades Institucionales de UNLaM
    tasks.push({
      materiaName: 'MIeL UNLaM (Institucional)',
      comisionId: 'unlam_global',
      sectionKey: 'unlam_global_novedades',
      type: 'novedad',
      url: 'https://miel.unlam.edu.ar/principal/novedades/',
      badgeCount: 0
    });

    console.log(`Consultando ${tasks.length} secciones en lotes paralelos (concurrencia: ${FETCH_CONCURRENCY})...`);

    // Ejecutar todas las consultas HTTP y parseo DOM dentro del contexto autenticado del navegador
    const rawResults = await page.evaluate(async ({ taskList, concurrency }) => {
      const cleanText = (el, removeSelectors = []) => {
        if (!el) return '';
        const clone = el.cloneNode(true);
        removeSelectors.forEach(sel => {
          clone.querySelectorAll(sel).forEach(n => n.remove());
        });
        return clone.textContent.trim().replace(/\s+/g, ' ');
      };

      const resolveUrl = (el, fallbackUrl) => {
        if (!el) return fallbackUrl;
        const raw = el.getAttribute('href') || '';
        if (!raw || raw.startsWith('javascript:')) return fallbackUrl;
        try {
          return new URL(raw, fallbackUrl).href;
        } catch {
          return fallbackUrl;
        }
      };

      const parseSectionDocument = (doc, task) => {
        const { comisionId: cId, type: sType, url: sUrl } = task;
        const extracted = [];

        // 1. MENSAJERÍA PRIVADA
        if (sType === 'mensajeria') {
          const rows = Array.from(doc.querySelectorAll('table tbody tr, tr.mensaje-no-leido, tr.mensaje-leido'));
          rows.forEach((row, idx) => {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length < 4) return;

            const isUnreadClass = row.classList.contains('mensaje-no-leido');
            const isReadClass = row.classList.contains('mensaje-leido');
            const botonLeido = row.querySelector('.botonLeido');
            const isUnreadState = botonLeido && botonLeido.getAttribute('data-estado') === '0';
            const mailIcon = row.querySelector('.material-icons');
            const iconText = mailIcon ? mailIcon.textContent.trim() : '';
            const isUnreadIcon = !isReadClass && (iconText === 'mail' || iconText === 'email' || iconText === 'markunread');

            if (isUnreadClass || isUnreadState || isUnreadIcon) {
              const fecha = cleanText(cells[0]) || 'Reciente';
              const remitente = cleanText(cells[1]) || 'Docente';
              const tieneAdjunto = Boolean(cells[2] && cells[2].querySelector('i.material-icons, [title*="adjunto"]'));
              const linkEl = cells[3].querySelector('a.verMensaje, a[href]');
              const asunto = cleanText(linkEl || cells[3]) || 'Sin asunto';
              const url = resolveUrl(linkEl, sUrl);
              const msgId = (botonLeido && botonLeido.getAttribute('data-id')) ||
                            (url.match(/\/id\/(\d+)/) ? url.match(/\/id\/(\d+)/)[1] : `${idx}_${fecha.replace(/[^a-zA-Z0-9]/g, '')}`);

              extracted.push({
                id: `${cId}_msg_${msgId}`,
                type: 'mensajeria',
                remitente,
                asunto,
                fecha,
                detalle: tieneAdjunto ? '📎 Contiene archivo adjunto' : null,
                url,
                isExplicitUnread: true,
                unreadCount: 1
              });
            }
          });
        }

        // 2. FOROS (/forov2/)
        else if (sType === 'foro') {
          const temas = Array.from(doc.querySelectorAll('.foro-tema, .foro-item'));
          temas.forEach((row, idx) => {
            const linkEl = row.querySelector('a[href]');
            const url = resolveUrl(linkEl, sUrl);
            const topicIdMatch = url.match(/tema\/(\d+)/);
            const topicId = topicIdMatch ? topicIdMatch[1] : String(idx);

            const tituloEl = row.querySelector('.w3-medium strong, strong');
            const titulo = cleanText(tituloEl) || 'Tema de foro';

            const badgeEl = row.querySelector('.w3-badge.w3-red, .badge-icono');
            const unreadCount = badgeEl ? (parseInt(badgeEl.textContent.trim(), 10) || 1) : 0;

            const iconoEl = row.querySelector('.foro-icono');
            const estadoTema = (iconoEl && iconoEl.getAttribute('title')) || 'Tema abierto';

            const descEl = row.querySelector('.w3-padding-4');
            const descripcion = cleanText(descEl, ['i.material-icons']);

            const statsEl = row.querySelector('.w3-text-grey');
            const statsText = cleanText(statsEl);

            const cantMatch = statsText.match(/(\d+)\s*mensajes?/i);
            const cantMensajes = cantMatch ? parseInt(cantMatch[1], 10) : 0;

            const fechaMatch = statsText.match(/Último mensaje\s+([\d/]+(?:\s+[\d:]+)?)/i);
            const fecha = fechaMatch ? fechaMatch[1].trim() : (cantMensajes > 0 ? statsText : 'Sin mensajes aún');

            const safeFecha = fecha.replace(/[^a-zA-Z0-9]/g, '');

            extracted.push({
              id: `${cId}_foro_${topicId}_m${cantMensajes}_${safeFecha}`,
              type: 'foro',
              remitente: unreadCount > 0
                ? `🔴 ${unreadCount} mensaje(s) sin leer (${cantMensajes} en total)`
                : `${cantMensajes} mensaje(s) en total · ${estadoTema}`,
              asunto: titulo,
              fecha,
              detalle: descripcion || null,
              url,
              isExplicitUnread: unreadCount > 0,
              unreadCount,
              cantMensajes,
              estadoTema
            });
          });
        }

        // 3. CONTENIDOS (/contenido/archivos/)
        else if (sType === 'contenido') {
          const rows = Array.from(doc.querySelectorAll('table tbody tr'));
          rows.forEach((row, idx) => {
            const btn = row.querySelector('a.btnDescargar, a[href*="descargarElemento"], a[data-id-archivo]');
            const cells = Array.from(row.querySelectorAll('td'));
            if (!btn || cells.length < 4) return;

            const url = resolveUrl(btn, sUrl);
            const idMatch = url.match(/\/id\/(\d+)/);
            const fileId = btn.getAttribute('data-id-archivo') || (idMatch ? idMatch[1] : String(idx));

            const nombre = cleanText(cells[1], ['.w3-hide', 'i.material-icons']) || 'Archivo subido';
            const descripcion = cleanText(cells[1].querySelector('.w3-text-grey'));
            const tipoLectura = cleanText(cells[2]) || 'General';
            const fecha = cleanText(cells[3]) || 'Reciente';
            const tamano = cleanText(cells[4]) || '';

            let unidad = '';
            const tbody = row.closest('tbody');
            if (tbody && tbody.previousElementSibling && tbody.previousElementSibling.tagName === 'THEAD') {
              const th = tbody.previousElementSibling.querySelector('th');
              unidad = cleanText(th, ['.w3-hide', 'i.material-icons']);
            }
            if (!unidad) {
              const accContent = row.closest('.w3-accordion-content');
              if (accContent && accContent.previousElementSibling) {
                unidad = cleanText(accContent.previousElementSibling.querySelector('span'));
              }
            }

            const noDescargado = Boolean(btn.querySelector('i.w3-text-theme'));
            const detalleParts = [];
            if (tipoLectura) detalleParts.push(`Lectura: ${tipoLectura}`);
            if (tamano) detalleParts.push(`Tamaño: ${tamano}`);
            if (descripcion) detalleParts.push(descripcion);

            extracted.push({
              id: `${cId}_contenido_${fileId}`,
              type: 'contenido',
              remitente: unidad || 'Material de cátedra',
              asunto: nombre,
              fecha,
              detalle: detalleParts.join(' · ') || null,
              url,
              isExplicitUnread: false,
              noDescargado
            });
          });
        }

        // 4. PORTAFOLIO (/portafolio/practicas/)
        else if (sType === 'portafolio') {
          const rows = Array.from(doc.querySelectorAll('table.w3-table tbody tr'));
          rows.forEach((row, idx) => {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length < 8) return;

            const entregaLink = row.querySelector('a[href*="/portafolio/entregas/"]');
            const url = resolveUrl(entregaLink, sUrl);
            const idMatch = url.match(/\/id\/(\d+)/);
            const practicaId = idMatch ? idMatch[1] : String(idx);

            const tituloRaw = cleanText(cells[0]);
            const tipoEntrega = cleanText(cells[1]);
            const vencimiento = cleanText(cells[2]) || '---';
            const fechaEntrega = cleanText(cells[4]) || '---';
            const fechaCorrec = cleanText(cells[5]) || '---';
            const estado = cleanText(cells[6]) || '---';
            const nota = cleanText(cells[7]) || '---';

            if (practicaId === '0' && estado === '---' && nota === '---') return;

            const hasGrade = (estado !== '---' && estado !== '') ||
                             (nota !== '---' && nota !== '') ||
                             (fechaCorrec !== '---' && fechaCorrec !== '');

            const safeState = `${estado}_${nota}_${fechaCorrec}`.replace(/[^a-zA-Z0-9_-]/g, '');

            extracted.push({
              id: `${cId}_portafolio_${practicaId}_${safeState}`,
              type: 'portafolio',
              remitente: hasGrade
                ? `Estado: ${estado} · Nota: ${nota}`
                : `Entrega: ${tipoEntrega} · Vencimiento: ${vencimiento}`,
              asunto: hasGrade
                ? `🎯 Corrección: ${tituloRaw}`
                : tituloRaw,
              fecha: hasGrade && fechaCorrec !== '---'
                ? fechaCorrec
                : (vencimiento !== '---' ? `Vence: ${vencimiento}` : 'Activa'),
              detalle: hasGrade
                ? `F. Entrega: ${fechaEntrega} · F. Corrección: ${fechaCorrec}`
                : `Trabajo práctico (${tipoEntrega || 'Portafolio'}) disponible.`,
              url,
              isExplicitUnread: false
            });
          });
        }

        // 5. EVALUACIONES Y ENCUESTAS
        else if (sType === 'evaluacion' || sType === 'encuesta') {
          const rows = Array.from(doc.querySelectorAll('table.w3-table tbody tr, .evaluacion-item, .encuesta-item'));
          rows.forEach((row) => {
            if (row.closest('.mfp-hide, #popupClave')) return;
            const text = cleanText(row);
            if (!text || text.includes('No hay evaluaciones') || text.includes('No hay encuestas')) return;

            const cells = Array.from(row.querySelectorAll('td'));
            const linkEl = row.querySelector('a[href]:not([href^="javascript"])');
            const url = resolveUrl(linkEl, sUrl);

            const asunto = cells[0] ? cleanText(cells[0]) : text.slice(0, 100);
            const estadoDetalle = cells.slice(1).map(c => cleanText(c)).filter(Boolean).join(' · ') || 'Disponible en MIeL';
            const fechaMatch = text.match(/\d{2}\/\d{2}\/\d{2,4}/);
            const fecha = fechaMatch ? fechaMatch[0] : 'Activa';

            extracted.push({
              id: `${cId}_${sType}_${asunto.slice(0, 16).replace(/[^a-zA-Z0-9]/g, '')}_${estadoDetalle.slice(0, 16).replace(/[^a-zA-Z0-9]/g, '')}`,
              type: sType,
              remitente: estadoDetalle,
              asunto,
              fecha,
              detalle: null,
              url,
              isExplicitUnread: false
            });
          });
        }

        // 6. NOVEDADES INSTITUCIONALES (/principal/novedades/)
        else if (sType === 'novedad') {
          const cards = Array.from(doc.querySelectorAll('.novedad'));
          cards.forEach((card, idx) => {
            const tituloEl = card.querySelector('h3, h2, strong');
            const titulo = tituloEl ? tituloEl.textContent.trim().replace(/\s+/g, ' ') : `Novedad #${idx + 1}`;
            const fechaEl = card.querySelector('.w3-text-gray, .w3-small');
            const fecha = fechaEl
              ? fechaEl.textContent.replace(/Publicado el/i, '').trim().replace(/\s+/g, ' ')
              : 'Reciente';
            const pEl = card.querySelector('p');
            const resumen = pEl ? pEl.textContent.trim().replace(/\s+/g, ' ').slice(0, 220) : '';
            const linkEl = card.querySelector('.novedad-contenido a.link');
            const url = resolveUrl(linkEl, sUrl);
            const imgEl = card.querySelector('.novedad-imagen img');
            const rawImg = imgEl ? (imgEl.getAttribute('src') || '') : '';
            let thumbnail = null;
            if (rawImg) {
              try {
                thumbnail = new URL(rawImg, sUrl).href;
              } catch {
                thumbnail = null;
              }
            }

            const safeTitle = titulo.slice(0, 20).replace(/[^a-zA-Z0-9]/g, '');
            const safeFecha = fecha.replace(/[^a-zA-Z0-9]/g, '');

            extracted.push({
              id: `unlam_novedad_${safeTitle}_${safeFecha}`,
              type: 'novedad',
              remitente: 'UNLaM / MIeL',
              asunto: titulo,
              fecha,
              detalle: resumen ? (resumen.length >= 220 ? `${resumen}...` : resumen) : null,
              url,
              thumbnail,
              isExplicitUnread: false
            });
          });
        }

        return extracted;
      };

      const results = [];
      const parser = new DOMParser();

      for (let i = 0; i < taskList.length; i += concurrency) {
        const batch = taskList.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(async (task) => {
          try {
            const response = await fetch(task.url, {
              method: 'GET',
              credentials: 'include',
              cache: 'no-store'
            });
            if (!response.ok) {
              return { task, items: [], error: `HTTP ${response.status}` };
            }
            const html = await response.text();
            const doc = parser.parseFromString(html, 'text/html');
            const items = parseSectionDocument(doc, task);
            return { task, items, error: null };
          } catch (err) {
            return { task, items: [], error: err.message };
          }
        }));
        results.push(...batchResults);
      }

      return results;
    }, { taskList: tasks, concurrency: FETCH_CONCURRENCY });

    const allUpdates = [];

    for (const { task, items, error } of rawResults) {
      if (error) {
        console.error(`Error al consultar ${task.type} de ${task.materiaName}:`, error);
        continue;
      }

      const explicitUnreadItems = items.filter(i => i.isExplicitUnread);
      const stateTrackedItems = items.filter(i => !i.isExplicitUnread);
      const seeded = isSectionSeeded(task.sectionKey);

      if (!seeded) {
        seedSectionItems(task.sectionKey, stateTrackedItems.map(i => i.id));
        console.log(`  [Baseline] Inicializada línea base de ${task.sectionKey} (${stateTrackedItems.length} ítem(s)).`);
      }

      const detectedForSection = [...explicitUnreadItems];

      if (seeded) {
        for (const item of stateTrackedItems) {
          if (item.type === 'foro' && item.estadoTema === 'Tema vencido') continue;
          if (!hasBeenNotified(item.id)) {
            detectedForSection.push(item);
          }
        }
      }

      if (detectedForSection.length > 0) {
        console.log(`  ¡Detectadas ${detectedForSection.length} novedad(es) en [${task.materiaName}] -> ${task.type}!`);
        detectedForSection.forEach(nov => {
          allUpdates.push({
            ...nov,
            materia: task.materiaName
          });
        });
      }
    }

    saveCheckMetadata({
      lastCheckTime: new Date().toISOString(),
      lastSubjects: subjectsSummary
    });

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Verificación completada en ${totalSeconds}s. Encontradas: ${allUpdates.length} novedad(es) activa(s).`);
    return allUpdates;

  } catch (error) {
    console.error('Error durante la ejecución del scraper:', error);
    const errorScreenshot = path.join(SCREENSHOTS_DIR, 'general_error.png');
    await page.screenshot({ path: errorScreenshot }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}
