import playwright from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config({ path: 'data.env' });

async function runForoDebug() {
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

    console.log('Logged in successfully, going to Foro...');
    
    // Find the first valid forum link on the active dashboard
    const foroUrl = await page.evaluate(() => {
      const link = document.querySelector('a[href*="/forov2/temas/comision/"]');
      return link ? link.href : null;
    });

    if (foroUrl) {
      console.log(`Going to active forum: ${foroUrl}`);
      await page.goto(foroUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.screenshot({ path: 'screenshots/foro_full.png', fullPage: true });

      const foroDOM = await page.evaluate(() => document.body.innerHTML);
      fs.writeFileSync('screenshots/foro_dom.txt', foroDOM, 'utf-8');
      console.log('Foro DOM saved to screenshots/foro_dom.txt');
    } else {
      console.log('No forum links found on dashboard.');
    }

    // Extract the main content of the forum to see its structure
    const foroDOM = await page.evaluate(() => {
      // Find the container that likely holds the forum items
      const container = document.body;
      return container ? container.innerHTML : 'No container found';
    });

    fs.writeFileSync('screenshots/foro_dom.txt', foroDOM, 'utf-8');
    console.log('Foro DOM saved to screenshots/foro_dom.txt');

  } catch (error) {
    console.error('Debug error:', error);
  } finally {
    await browser.close();
  }
}

runForoDebug();
