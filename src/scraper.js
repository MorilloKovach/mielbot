import playwright from 'playwright';
import path from 'path';
import fs from 'fs';
import { isSectionSeeded, seedSectionItems, hasBeenNotified, saveCheckMetadata } from './database.js';

// Asegurar que exista la carpeta de capturas de pantalla
const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Lanza el navegador con fallback automático al navegador integrado de Playwright
 * si PLAYWRIGHT_EXECUTABLE_PATH no existe o falla al iniciar (evita error kill ESRCH en la nube).
 */
async function launchBrowserWithFallback(browserType, headless, executablePath) {
  const baseArgs = browserType === 'chromium' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];

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

  const browser = await launchBrowserWithFallback(browserType, headless, executablePath);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'es-AR'
  });

  const page = await context.newPage();

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
      page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).catch(() => {}),
      page.keyboard.press('Enter')
    ]);

    console.log('Verificando estado post-login...');
    await page.waitForSelector('.materia-bloque, .w3-panel.w3-red, .error, .alert', { timeout: 30000 }).catch(() => {
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

    console.log('Inicio de sesión exitoso. Url actual:', currentUrl);

    await page.waitForSelector('.materia-bloque', { timeout: 30000 }).catch(() => {
      console.log('Advertencia: No se encontraron bloques de materias (.materia-bloque). Procediendo...');
    });

    // Extraer las materias y sus secciones desde el dashboard
    const materias = await page.evaluate(() => {
      const bloques = Array.from(document.querySelectorAll('.materia-bloque'));
      return bloques.map(bloque => {
        const comisionId = bloque.getAttribute('data-id') || 'unknown';
        const tituloEl = bloque.querySelector('.materia-titulo');
        const detalleEl = bloque.querySelector('.materia-descripcion div.w3-small');

        let nombre = tituloEl ? tituloEl.textContent.trim() : 'Materia sin nombre';
        let codigoDetalle = '';
        if (detalleEl) {
          codigoDetalle = detalleEl.textContent.trim()
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

    const allUpdates = [];
    const subjectsSummary = [];

    console.log(`Relevando ${materias.length} materias activas...`);

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

        console.log(`[${materia.name}] Revisando sección: ${seccion.type}${seccion.badgeCount > 0 ? ` (Badge: ${seccion.badgeCount})` : ''}...`);
        try {
          await page.goto(seccion.url, { waitUntil: 'domcontentloaded', timeout: 45000 });

          const comisionIdMatch = seccion.url.match(/comision\/(\d+)/);
          const comisionId = comisionIdMatch ? comisionIdMatch[1] : materia.comisionId;
          const sectionKey = `${comisionId}_${seccion.type}`;

          const items = await page.evaluate(({ cId, sType, sUrl }) => {
            const extracted = [];

            const cleanText = (el, removeSelectors = []) => {
              if (!el) return '';
              const clone = el.cloneNode(true);
              removeSelectors.forEach(sel => {
                clone.querySelectorAll(sel).forEach(n => n.remove());
              });
              return clone.textContent.trim().replace(/\s+/g, ' ');
            };

            // 1. MENSAJERÍA PRIVADA
            if (sType === 'mensajeria') {
              const rows = Array.from(document.querySelectorAll('table tbody tr, tr.mensaje-no-leido, tr.mensaje-leido'));
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
                  const url = linkEl ? linkEl.href : sUrl;
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
              const temas = Array.from(document.querySelectorAll('.foro-tema, .foro-item'));
              temas.forEach((row, idx) => {
                const linkEl = row.querySelector('a[href]');
                const url = linkEl ? linkEl.href : sUrl;
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
              const rows = Array.from(document.querySelectorAll('table tbody tr'));
              rows.forEach((row, idx) => {
                const btn = row.querySelector('a.btnDescargar, a[href*="descargarElemento"], a[data-id-archivo]');
                const cells = Array.from(row.querySelectorAll('td'));
                if (!btn || cells.length < 4) return;

                const url = btn.href || sUrl;
                const idMatch = url.match(/\/id\/(\d+)/);
                const fileId = btn.getAttribute('data-id-archivo') || (idMatch ? idMatch[1] : String(idx));

                const nombre = cleanText(cells[1], ['.w3-hide', 'i.material-icons']) || 'Archivo subido';
                const descripcion = cleanText(cells[1].querySelector('.w3-text-grey'));
                const tipoLectura = cleanText(cells[2]) || 'General';
                const fecha = cleanText(cells[3]) || 'Reciente';
                const tamano = cleanText(cells[4]) || '';

                // Buscar el nombre de la unidad en el thead anterior y/o módulo acordeón
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
              const rows = Array.from(document.querySelectorAll('table.w3-table tbody tr'));
              rows.forEach((row, idx) => {
                const cells = Array.from(row.querySelectorAll('td'));
                if (cells.length < 8) return;

                const entregaLink = row.querySelector('a[href*="/portafolio/entregas/"]');
                const url = entregaLink ? entregaLink.href : sUrl;
                const idMatch = url.match(/\/id\/(\d+)/);
                const practicaId = idMatch ? idMatch[1] : String(idx);

                // Omitir la fila genérica "Otras prácticas" con id 0 si no tiene entrega ni nota
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
              const rows = Array.from(document.querySelectorAll('table.w3-table tbody tr, .evaluacion-item, .encuesta-item'));
              rows.forEach((row, idx) => {
                if (row.closest('.mfp-hide, #popupClave')) return;
                const text = cleanText(row);
                if (!text || text.includes('No hay evaluaciones') || text.includes('No hay encuestas')) return;

                const cells = Array.from(row.querySelectorAll('td'));
                const linkEl = row.querySelector('a[href]:not([href^="javascript"])');
                const url = linkEl ? linkEl.href : sUrl;

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

            return extracted;
          }, { cId: comisionId, sType: seccion.type, sUrl: seccion.url });

          // Procesar línea base (baseline) vs novedades reales para evitar falsos positivos de años anteriores
          const explicitUnreadItems = items.filter(i => i.isExplicitUnread);
          const stateTrackedItems = items.filter(i => !i.isExplicitUnread);

          const seeded = isSectionSeeded(sectionKey);

          if (!seeded) {
            // Primera vez que escaneamos esta sección: guardamos todos los ítems sin marca de "no leído"
            // como línea base para no spamear materiales o tópicos viejos de años anteriores.
            seedSectionItems(sectionKey, stateTrackedItems.map(i => i.id));
            console.log(`  [Baseline] Inicializada línea base de ${sectionKey} con ${stateTrackedItems.length} ítem(s) existentes.`);
          }

          // Los ítems con marca explícita de no leído (mensajes no leídos, foros con badge rojo) siempre se reportan
          const detectedForSection = [...explicitUnreadItems];

          // Si la sección ya tenía línea base, cualquier ítem nuevo cuyo ID no esté registrado es una novedad real
          if (seeded) {
            for (const item of stateTrackedItems) {
              // En foros sin badge rojo, ignorar temas vencidos viejos
              if (item.type === 'foro' && item.estadoTema === 'Tema vencido') continue;
              if (!hasBeenNotified(item.id)) {
                detectedForSection.push(item);
              }
            }
          }

          if (detectedForSection.length > 0) {
            console.log(`  ¡Detectadas ${detectedForSection.length} novedad(es) activa(s) en ${seccion.type}!`);
            detectedForSection.forEach(nov => {
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

      subjectsSummary.push(matSummary);
    }

    // 6. NOVEDADES GENERALES DE MIeL (/principal/novedades/)
    try {
      const novedadesUrl = 'https://miel.unlam.edu.ar/principal/novedades/';
      console.log('[UNLaM General] Revisando sección: novedades institucionales...');
      await page.goto(novedadesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const generalNovedades = await page.evaluate((sUrl) => {
        const cards = Array.from(document.querySelectorAll('.novedad'));
        return cards.map((card, idx) => {
          const tituloEl = card.querySelector('h3, h2, strong');
          const titulo = tituloEl ? tituloEl.textContent.trim().replace(/\s+/g, ' ') : `Novedad #${idx + 1}`;
          const fechaEl = card.querySelector('.w3-text-gray, .w3-small');
          const fecha = fechaEl
            ? fechaEl.textContent.replace(/Publicado el/i, '').trim().replace(/\s+/g, ' ')
            : 'Reciente';
          const pEl = card.querySelector('p');
          const resumen = pEl ? pEl.textContent.trim().replace(/\s+/g, ' ').slice(0, 220) : '';
          const linkEl = card.querySelector('.novedad-contenido a.link');
          const url = linkEl ? linkEl.href : sUrl;
          const imgEl = card.querySelector('.novedad-imagen img');
          const thumbnail = imgEl ? imgEl.src : null;

          const safeTitle = titulo.slice(0, 20).replace(/[^a-zA-Z0-9]/g, '');
          const safeFecha = fecha.replace(/[^a-zA-Z0-9]/g, '');

          return {
            id: `unlam_novedad_${safeTitle}_${safeFecha}`,
            type: 'novedad',
            materia: 'MIeL UNLaM (Institucional)',
            remitente: 'UNLaM / MIeL',
            asunto: titulo,
            fecha,
            detalle: resumen ? (resumen.length >= 220 ? `${resumen}...` : resumen) : null,
            url,
            thumbnail,
            isExplicitUnread: false
          };
        });
      }, novedadesUrl);

      const generalKey = 'unlam_global_novedades';
      if (!isSectionSeeded(generalKey)) {
        seedSectionItems(generalKey, generalNovedades.map(n => n.id));
        console.log(`  [Baseline] Inicializada línea base de novedades institucionales (${generalNovedades.length} ítem(s)).`);
      } else {
        for (const nov of generalNovedades) {
          if (!hasBeenNotified(nov.id)) {
            allUpdates.push(nov);
          }
        }
      }
    } catch (err) {
      console.error('Error al revisar novedades generales de MIeL:', err.message);
    }

    saveCheckMetadata({
      lastCheckTime: new Date().toISOString(),
      lastSubjects: subjectsSummary
    });

    console.log(`Verificación completada. Encontradas: ${allUpdates.length} novedad(es) activa(s).`);
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
