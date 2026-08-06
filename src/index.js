import { Client, GatewayIntentBits, Partials, REST, Routes, ActivityType } from 'discord.js';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { checkMielUpdates } from './scraper.js';
import { hasBeenNotified, markAsNotified, loadDatabase } from './database.js';

// Cargar variables de entorno
dotenv.config();

const {
  DISCORD_TOKEN,
  DISCORD_USER_ID,
  MIEL_DNI,
  MIEL_PASSWORD,
  CHECK_INTERVAL_CRON = '*/30 * * * *',
  PLAYWRIGHT_HEADLESS = 'true'
} = process.env;

// Validar variables de entorno requeridas
if (!DISCORD_TOKEN) {
  console.error('❌ ERROR: DISCORD_TOKEN no está definido en el archivo .env.');
  process.exit(1);
}

if (!DISCORD_USER_ID) {
  console.error('⚠️ ADVERTENCIA: DISCORD_USER_ID no está definido. El bot no podrá enviarte notificaciones automáticas.');
}

// Inicializar el cliente de Discord con soporte para Guilds, DMs y Mensajes
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ],
  partials: [
    Partials.Channel,
    Partials.Message
  ]
});

// Definición de Comandos Slash
const commands = [
  {
    name: 'check',
    description: 'Verifica inmediatamente si hay novedades en MIeL.'
  },
  {
    name: 'status',
    description: 'Muestra el estado del bot y cuándo se realizó la última comprobación.'
  },
  {
    name: 'help',
    description: 'Muestra la ayuda y comandos disponibles.'
  }
];

let lastCheckTime = null;
let isChecking = false;
let consecutiveFailures = 0;

// Registrar comandos slash en Discord
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    console.log('Iniciando registro de comandos slash...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ Comandos slash registrados globalmente con éxito.');
  } catch (error) {
    console.error('❌ Error al registrar comandos slash:', error);
  }
}

// Función para realizar la comprobación de MIeL y enviar alertas
async function performCheck(manualUser = null) {
  if (isChecking) {
    console.log('Ya se está realizando una comprobación. Omitiendo...');
    if (manualUser) {
      await manualUser.send('Ya hay una verificación en curso. Por favor, espera un momento.');
    }
    return;
  }

  isChecking = true;
  console.log(`[${new Date().toLocaleString()}] Iniciando verificación de MIeL...`);

  try {
    const credentials = { usuario: MIEL_DNI, clave: MIEL_PASSWORD };
    const headless = PLAYWRIGHT_HEADLESS !== 'false';

    const updates = await checkMielUpdates(credentials, headless);
    lastCheckTime = new Date();
    consecutiveFailures = 0;

    console.log(`Verificación completada. Encontradas: ${updates.length} novedades.`);

    let newUpdatesCount = 0;
    const notifiedUser = manualUser || (await client.users.fetch(DISCORD_USER_ID).catch(() => null));

    for (const update of updates) {
      if (!hasBeenNotified(update.id)) {
        newUpdatesCount++;

        // Determinar estilo de la alerta según el tipo de novedad
        let titleIcon = '✉️';
        let typeName = 'Mensaje';
        let actionDesc = 'un nuevo mensaje no leído';
        let fieldNameAutor = '👤 Remitente';
        let fieldNameDesc = '📝 Asunto';

        switch (update.type) {
          case 'foro':
            titleIcon = '💬';
            typeName = 'Foro';
            actionDesc = 'una nueva actualización en el foro';
            fieldNameAutor = '👤 Autor/a';
            fieldNameDesc = '📝 Tópico';
            break;
          case 'contenido':
            titleIcon = '📚';
            typeName = 'Contenido';
            actionDesc = 'un nuevo material/contenido publicado';
            fieldNameAutor = '📁 Sección';
            fieldNameDesc = '📝 Archivo/Unidad';
            break;
          case 'evaluacion':
            titleIcon = '📝';
            typeName = 'Evaluación';
            actionDesc = 'una nueva evaluación o nota publicada';
            fieldNameAutor = '👤 Profesor/a';
            fieldNameDesc = '📝 Título';
            break;
          case 'portafolio':
            titleIcon = '💼';
            typeName = 'Portafolio';
            actionDesc = 'un nuevo trabajo práctico en tu portafolio';
            fieldNameAutor = '👤 Autor/a';
            fieldNameDesc = '📝 Título';
            break;
        }

        // Crear una notificación Embed interactiva y elegante
        const embed = {
          color: 0xffa500, // Color naranja característico
          title: `${titleIcon} Nuevo ${typeName} en ${update.materia}`,
          url: 'https://miel.unlam.edu.ar',
          description: `Tienes ${actionDesc} en la plataforma MIeL.`,
          fields: [
            { name: fieldNameAutor, value: update.remitente, inline: true },
            { name: '📅 Fecha', value: update.fecha, inline: true },
            { name: fieldNameDesc, value: update.asunto }
          ],
          footer: {
            text: 'MIeL Notificador'
          },
          timestamp: new Date().toISOString()
        };

        if (notifiedUser) {
          await notifiedUser.send({ embeds: [embed] }).catch(err => {
            console.error(`No se pudo enviar la alerta por DM al usuario:`, err);
          });
        }
        
        // Marcar en la base de datos para no repetir
        markAsNotified(update.id);
      }
    }

    if (manualUser) {
      if (newUpdatesCount > 0) {
        await manualUser.send(`✅ Comprobación manual finalizada. Te he enviado ${newUpdatesCount} alertas de nuevas novedades.`);
      } else {
        await manualUser.send('🔍 Comprobación manual finalizada. No tienes nuevos mensajes sin leer en MIeL.');
      }
    }

  } catch (error) {
    console.error('Error al comprobar actualizaciones de MIeL:', error);
    consecutiveFailures++;

    // Si hay demasiados errores consecutivos, notificar al usuario
    if (consecutiveFailures >= 3 || manualUser) {
      const notifiedUser = manualUser || (await client.users.fetch(DISCORD_USER_ID).catch(() => null));
      if (notifiedUser) {
        await notifiedUser.send(
          `⚠️ **Alerta del Bot**: Se han producido ${consecutiveFailures} fallos consecutivos al intentar verificar tu cuenta de MIeL.\n` +
          `**Detalle del error:** \`${error.message}\`\n` +
          `Por favor, verifica que tu DNI y clave en el archivo \`.env\` sean válidos y que el servidor de MIeL funcione.`
        ).catch(() => {});
      }
    }
  } finally {
    isChecking = false;
  }
}

// Evento Ready
client.once('ready', async () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
  
  // Establecer actividad de estado
  client.user.setActivity('novedades de MIeL', { type: ActivityType.Watching });

  // Registrar los comandos slash
  await registerCommands();

  // Enviar mensaje de bienvenida si se configuró el ID del usuario
  if (DISCORD_USER_ID) {
    const owner = await client.users.fetch(DISCORD_USER_ID).catch(() => null);
    if (owner) {
      await owner.send('👋 ¡Hola! El bot de MIeL se ha iniciado correctamente. Estaré monitoreando novedades según tu programación. Puedes usar `/check` para forzar una comprobación.').catch(() => {});
    }
  }

  // Programar la tarea de cron
  console.log(`⏰ Programando verificación automática con la expresión cron: "${CHECK_INTERVAL_CRON}"`);
  cron.schedule(CHECK_INTERVAL_CRON, () => {
    performCheck().catch(err => console.error('Error en tarea programada:', err));
  });
});

// Evento InteractionCreate (Comandos Slash)
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  // Restringir el bot para que solo responda al usuario dueño si está configurado DISCORD_USER_ID
  if (DISCORD_USER_ID && user.id !== DISCORD_USER_ID) {
    return interaction.reply({ content: '❌ No estás autorizado para usar este bot.', ephemeral: true }).catch(() => {});
  }

  try {
    if (commandName === 'check') {
      if (isChecking) {
        return interaction.reply({ content: '⏳ Ya hay una comprobación de MIeL en curso. Por favor, espera a que termine.', ephemeral: true }).catch(() => {});
      }

      try {
        await interaction.deferReply();
      } catch (deferError) {
        console.error('Error al diferir respuesta (posible expiración de 3s):', deferError.message);
        return; // Detener flujo para evitar crash por interaction no válida
      }

      isChecking = true;

      try {
        const credentials = { usuario: MIEL_DNI, clave: MIEL_PASSWORD };
        const headless = PLAYWRIGHT_HEADLESS !== 'false';

        const allUpdates = await checkMielUpdates(credentials, headless);
        lastCheckTime = new Date();
        consecutiveFailures = 0;

        // Filtrar novedades que ya fueron notificadas/leídas por el bot
        const updates = allUpdates.filter(u => !hasBeenNotified(u.id));

        if (updates.length === 0) {
          await interaction.editReply('🔍 **Comprobación finalizada:** No tienes novedades nuevas sin leer en ninguna materia de MIeL.').catch(() => {});
          return;
        }

        // Limitar a los primeros 10 para no superar los límites de campos de un Embed de Discord (25)
        const visibleUpdates = updates.slice(0, 10);

        const embed = {
          color: 0xffa500,
          title: `📥 Novedades sin leer en MIeL (${updates.length})`,
          url: 'https://miel.unlam.edu.ar',
          description: 'Se han encontrado las siguientes novedades en tu perfil:',
          fields: visibleUpdates.map(u => ({
            name: `📚 ${u.materia} (${u.type.toUpperCase()})`,
            value: `👤 **De:** ${u.remitente}\n📝 **Detalle:** ${u.asunto}\n📅 **Fecha:** ${u.fecha}`,
            inline: false
          })),
          footer: {
            text: updates.length > 10 ? `Mostrando 10 de ${updates.length} novedades. Revisa la plataforma.` : 'MIeL Notificador'
          },
          timestamp: new Date().toISOString()
        };

        await interaction.editReply({ content: '✅ ¡Comprobación finalizada!', embeds: [embed] }).catch(() => {});

        // Marcar como notificados para evitar spam de la tarea automática en segundo plano
        for (const update of updates) {
          markAsNotified(update.id);
        }

      } catch (error) {
        console.error('Error en comprobación manual:', error);
        consecutiveFailures++;
        await interaction.editReply(`❌ Ocurrió un error al verificar MIeL: \`${error.message}\``).catch(() => {});
      } finally {
        isChecking = false;
      }
    } 
    
    else if (commandName === 'status') {
      const db = loadDatabase();
      const statusEmbed = {
        color: 0x00ae86,
        title: '📊 Estado del Bot de MIeL',
        fields: [
          { name: 'Última Comprobación', value: lastCheckTime ? lastCheckTime.toLocaleString() : 'Nunca', inline: true },
          { name: 'Historial Notificado', value: `${db.notifiedIds.length} ítems`, inline: true },
          { name: 'Intervalo de Monitoreo', value: `Cron: \`${CHECK_INTERVAL_CRON}\``, inline: false },
          { name: 'Fallas Consecutivas', value: `${consecutiveFailures}`, inline: true },
          { name: 'Estado Actual', value: isChecking ? 'Buscando novedades...' : 'En espera', inline: true }
        ],
        timestamp: new Date().toISOString()
      };
      await interaction.reply({ embeds: [statusEmbed] }).catch(() => {});
    } 
    
    else if (commandName === 'help') {
      const helpEmbed = {
        color: 0x3498db,
        title: '❓ Ayuda - MIeL Notificador',
        description: 'Este bot inicia sesión en tu cuenta de MIeL de manera programada y te notifica por mensaje directo si tienes nuevos mensajes de profesores sin leer.',
        fields: [
          { name: '`/check`', value: 'Fuerza una revisión inmediata de tu bandeja de entrada en MIeL.' },
          { name: '`/status`', value: 'Muestra estadísticas y cuándo fue la última revisión.' },
          { name: '`/help`', value: 'Muestra este mensaje.' }
        ],
        footer: {
          text: 'Desarrollado para UNLaM MIeL'
        }
      };
      await interaction.reply({ embeds: [helpEmbed] }).catch(() => {});
    }
  } catch (globalError) {
    console.error('Error global en InteractionCreate:', globalError.message);
  }
});

// Iniciar sesión en Discord
client.login(DISCORD_TOKEN);
