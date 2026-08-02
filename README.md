# MIeL UNLaM - Notificador de Discord

Este proyecto es un bot de Discord personal que inicia sesión automáticamente en tu cuenta de la plataforma **MIeL (Universidad Nacional de La Matanza)**, verifica si tienes mensajes nuevos sin leer y te los envía de forma directa y privada (DM) con un formato elegante.

## Características

- 🔍 **Monitoreo automático:** Consulta tu casilla de MIeL periódicamente mediante una expresión cron.
- ✉️ **Mensajes Directos:** Te notifica en privado mediante un mensaje incrustado (Embed) con el remitente, fecha y asunto.
- 🛠️ **Comandos Slash:** Puedes forzar una comprobación manual (`/check`) o ver el estado del bot (`/status`).
- 📷 **Capturas en caso de error:** Si algo falla (como que la plataforma cambie de diseño), el bot guarda una captura de pantalla en la carpeta `screenshots/` para facilitar la depuración.
- 🦊 **Uso de navegador local:** Configurado para usar el Firefox instalado en tu sistema Linux, evitando descargas lentas.

---

## Requisitos Previos

1. **Node.js** (versión 18 o superior) instalado.
2. **Firefox** instalado en tu sistema (usado por el automatizador web Playwright).

---

## Configuración paso a paso

### 1. Crear el Bot de Discord y obtener el Token

1. Accede al [Discord Developer Portal](https://discord.com/developers/applications).
2. Haz clic en **New Application** en la esquina superior derecha y dale un nombre (ej. `MIeL Notifier`).
3. Ve a la pestaña **Bot** en el menú izquierdo:
   - Haz clic en **Reset Token** y copia el token generado. Este será tu `DISCORD_TOKEN`.
   - En la sección **Privileged Gateway Intents**, activa las siguientes opciones:
     - **Guild Members Intent** (opcional, pero útil)
     - **Message Content Intent** (requerido para procesar interacciones)
4. Ve a la pestaña **OAuth2** -> **URL Generator** en el menú izquierdo:
   - En **Scopes**, marca `bot` y `applications.commands`.
   - En **Bot Permissions**, marca `Send Messages` y `Embed Links`.
   - Copia la URL generada al final de la página y ábrela en tu navegador para añadir el bot a tu servidor de Discord (es necesario que esté en al menos un servidor para poder comunicarse contigo, aunque sea un servidor vacío tuyo).

### 2. Obtener tu Discord User ID

Para que el bot pueda enviarte mensajes privados directos, necesita conocer tu identificador numérico de Discord:
1. Abre tu aplicación de Discord y ve a **Ajustes de usuario** -> **Avanzado**.
2. Activa el **Modo desarrollador**.
3. Haz clic derecho sobre tu foto de perfil o tu nombre en cualquier chat y selecciona **Copiar ID de usuario**. Este será tu `DISCORD_USER_ID`.

### 3. Configurar el archivo `.env`

Abre el archivo `.env` en la raíz del proyecto y rellena tus datos:

```ini
# Configuración del Bot de Discord
DISCORD_TOKEN=copia_tu_token_aqui
DISCORD_USER_ID=copia_tu_id_de_usuario_aqui

# Credenciales de MIeL UNLaM
MIEL_DNI=tu_dni
MIEL_PASSWORD=tu_clave_de_miel

# Configuración del Scraper y Programación
# '*/30 * * * *' significa verificar cada 30 minutos.
CHECK_INTERVAL_CRON=*/30 * * * *

# Cambiar a 'false' si quieres ver la ventana del navegador trabajando
PLAYWRIGHT_HEADLESS=true
```

---

## Cómo Ejecutar el Bot

### 1. Probar el Scraper (Dry-run)

Antes de iniciar el bot de Discord, puedes verificar que tus credenciales de MIeL y el motor de navegación funcionan correctamente con la prueba local:

```bash
npm run test:scraper
```

Este comando simulará el login y listará tus materias y mensajes en la terminal sin conectarse a Discord. Si ves que no encuentra nada o da error, puedes revisar la carpeta `screenshots/` para ver qué ocurrió.

### 2. Iniciar el Bot de Discord

Una vez verificado que el scraper funciona correctamente, inicia el bot de Discord:

```bash
npm start
```

El bot se conectará, registrará los comandos slash (`/check`, `/status`, `/help`) y te enviará un mensaje privado de bienvenida en Discord. A partir de ese momento, se ejecutará en segundo plano comprobando tu cuenta de MIeL periódicamente.

---

## Solución de Problemas

- **Fallo de Login**: Verifica que tu DNI y contraseña en `.env` sean exactamente los mismos que usas en el sistema Intraconsulta / MIeL.
- **Error de Navegador**: Si el bot da error de "Executable not found", asegúrate de que Firefox esté instalado en la ruta `/usr/bin/firefox`. Si está en otra ruta, modifícala en la propiedad `PLAYWRIGHT_EXECUTABLE_PATH` de tu archivo `.env`.
