import playwright from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config({ path: 'data.env' });

async function runDashboardDebug() {
  const credentials = {
    usuario: process.env.MIEL_DNI,
    clave: process.env.MIEL_PASSWORD
  };

  const browserType = process.env.PLAYWRIGHT_BROWSER_TYPE || 'chromium';
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;

  const browser = await playwright[browserType].launch({
    headless: true,
    executablePath,
    args: browserType === 'chromium' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Logging in...');
    await page.goto('https://miel.unlam.edu.ar', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="usuario"]', credentials.usuario);
    await page.fill('input[name="clave"]', credentials.clave);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {}),
      page.keyboard.press('Enter')
    ]);

    await page.waitForSelector('.materia-bloque', { timeout: 15000 });
    console.log('Logged in successfully, extracting dashboard DOM...');

    // Tomar captura del dashboard completo
    await page.screenshot({ path: 'screenshots/dashboard_full.png', fullPage: true });

    // Extraer y guardar el HTML del primer y segundo bloque de materia para ver los enlaces
    const blocksDOM = await page.evaluate(() => {
      const blocks = document.querySelectorAll('.materia-bloque');
      let dump = '';
      for (let i = 0; i < Math.min(2, blocks.length); i++) {
        dump += `--- Materia #${i} HTML ---\n${blocks[i].outerHTML}\n\n`;
      }
      return dump;
    });

    fs.writeFileSync('screenshots/dashboard_blocks_dom.txt', blocksDOM, 'utf-8');
    console.log('DOM blocks saved to screenshots/dashboard_blocks_dom.txt');

  } catch (error) {
    console.error('Debug error:', error);
  } finally {
    await browser.close();
  }
}

runDashboardDebug();
