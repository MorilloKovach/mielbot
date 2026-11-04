import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import dotenv from 'dotenv';
import fs from 'fs';
import cron from 'node-cron';
import { checkMielUpdates } from './scraper.js';
import {
  hasBeenNotified,
  markMultipleAsNotified,
  loadDatabase
} from './database.js';

// Cargar variables de entorno (.env con fallback automático a data.env)
const envPath = fs.existsSync('.env') ? '.env' : (fs.existsSync('data.env') ? 'data.env' : '.env');
dotenv.config({ path: envPath });

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
  console.error('❌ ERROR: DISCORD_TOKEN no está definido en el archivo .env / data.env.');
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
    description: 'Verifica inmediatamente si hay novedades o pendientes sin leer en MIeL.'
  },
  {
    name: 'materias',
    description: 'Muestra tus materias activas monitoreadas y si tienen alertas en el tablero de MIeL.'
  },
  {
    name: 'status',
    description: 'Muestra el estado del bot, estadísticas de monitoreo y última comprobación.'
  },
  {
    name: 'help',
    description: 'Muestra la ayuda y comandos disponibles.'
  }
];

let lastCheckTime = null;
let isChecking = false;
let consecutiveFailures = 0;

const TYPE_META = {
  mensajeria: {
    icon: '✉️',
    label: 'Mensaje Privado',
    color: 0x3498db,
    buttonLabel: 'Abrir Mensaje en MIeL',
    authorField: '👤 Remitente',
    subjectField: '📝 Asunto',
    dateField: '📅 Fecha'
  },
  foro: {
    icon: '💬',
    label: 'Foro',
    color: 0xe67e22,
    buttonLabel: 'Ver Tópico en MIeL',
    authorField: '📊 Actividad',
    subjectField: '📌 Tópico',
    dateField: '🕒 Último mensaje'
  },
  contenido: {
    icon: '📚',
    label: 'Contenido',
    color: 0x2ecc71,
    buttonLabel: 'Ver / Descargar Archivo',
    authorField: '📁 Unidad / Módulo',
    subjectField: '📄 Archivo / Recurso',
    dateField: '📅 Fecha de subida'
  },
  portafolio: {
    icon: '💼',
    label: 'Portafolio',
    color: 0x9b59b6,
    buttonLabel: 'Abrir Portafolio en MIeL',
    authorField: '📊 Estado / Condición',
    subjectField: '📝 Práctica / TP',
    dateField: '📅 Fecha'
  },
  evaluacion: {
    icon: '📝',
    label: 'Evaluación',
    color: 0xe74c3c,
    buttonLabel: 'Ver Evaluación en MIeL',
    authorField: '📊 Estado / Detalle',
    subjectField: '📌 Evaluación',
    dateField: '📅 Fecha'
  },
  encuesta: {
    icon: '📋',
    label: 'Encuesta',
    color: 0x1abc9c,
    buttonLabel: 'Abrir Encuesta en MIeL',
    authorField: '📊 Estado',
    subjectField: '📌 Encuesta',
    dateField: '📅 Fecha'
  },
  novedad: {
    icon: '📢',
    label: 'Novedad UNLaM',
    color: 0xf1c40f,
    buttonLabel: 'Ver Novedad en MIeL',
    authorField: '🏛️ Origen',
    subjectField: '📌 Título',
    dateField: '📅 Publicado'
  }
};

/**
 * Construye el Embed y botón interactivo para una notificación individual.
 */
function buildNotificationPayload(update) {
  const meta = TYPE_META[update.type] || TYPE_META.mensajeria;
  const targetUrl = update.url || 'https://miel.unlam.edu.ar';

  let description = `Se detectó una novedad de **${meta.label}** en **${update.materia}**.`;
  if (update.type === 'foro' && update.unreadCount > 0) {
    description = `Tienes **${update.unreadCount} mensaje(s) sin leer** en el foro de **${update.materia}**.`;
  } else if (update.type === 'mensajeria') {
    description = `Tienes un **nuevo mensaje sin leer** en la bandeja de entrada de **${update.materia}**.`;
  } else if (update.type === 'contenido') {
    description = `Se publicó nuevo material de estudio en **${update.materia}**.`;
  } else if (update.type === 'portafolio') {
    description = `Hay una actualización de trabajo práctico en el portafolio de **${update.materia}**.`;
  }

  const fields = [
    { name: meta.subjectField, value: `**${update.asunto || 'Sin título'}**`, inline: false },
    { name: meta.authorField, value: update.remitente || 'MIeL', inline: true },
    { name: meta.dateField, value: update.fecha || 'Reciente', inline: true }
  ];

  if (update.detalle) {
    fields.push({
      name: 'ℹ️ Detalle adicional',
      value: update.detalle.slice(0, 1024),
      inline: false
    });
  }

  const embed = {
    color: meta.color,
    title: `${meta.icon} ${meta.label} — ${update.materia}`,
    url: targetUrl,
    description,
    fields,
    footer: {
      text: 'MIeL Notificador · UNLaM'
    },
    timestamp: new Date().toISOString()
  };

  if (update.thumbnail && update.thumbnail.startsWith('http')) {
    embed.thumbnail = { url: update.thumbnail };
  }

  const components = [];
  if (targetUrl && targetUrl.startsWith('http')) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel(meta.buttonLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(targetUrl)
    );
    components.push(row);
  }

  return { embeds: [embed], components };
}

/**
 * Formatea una lista de novedades en campos compactos para el Embed resumen de /check.
 */
function buildSummaryFields(updatesList) {
  return updatesList.slice(0, 10).map(u => {
    const meta = TYPE_META[u.type] || TYPE_META.mensajeria;
    const linkPart = u.url ? ` · [Abrir en MIeL](${u.url})` : '';
    const detailPart = u.detalle ? `\nℹ️ *${u.detalle.slice(0, 140)}${u.detalle.length > 140 ? '...' : ''}*` : '';

    return {
      name: `${meta.icon} ${u.materia} — ${meta.label.toUpperCase()}`,
      value:
        `📌 **${u.asunto}**\n` +
        `📊 ${u.remitente} · 📅 ${u.fecha}${linkPart}${detailPart}`,
      inline: false
    };
  });
}

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

// Función para realizar la comprobación automática de MIeL y enviar alertas por DM
async function performCheck(manualUser = null) {
  if (isChecking) {
    console.log('Ya se está realizando una comprobación. Omitiendo...');
    if (manualUser) {
      await manualUser.send('⏳ Ya hay una verificación en curso. Por favor, espera un momento.');
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

    const newUpdates = updates.filter(u => !hasBeenNotified(u.id));
    console.log(`Verificación completada. Total activas: ${updates.length}, Nuevas sin notificar: ${newUpdates.length}.`);

    const notifiedUser = manualUser || (DISCORD_USER_ID ? await client.users.fetch(DISCORD_USER_ID).catch(() => null) : null);

    if (newUpdates.length > 0) {
      for (const update of newUpdates) {
        if (notifiedUser) {
          const payload = buildNotificationPayload(update);
          await notifiedUser.send(payload).catch(err => {
            console.error('No se pudo enviar la alerta por DM al usuario:', err.message);
          });
        }
      }
      markMultipleAsNotified(newUpdates.map(u => u.id));
    }

    if (manualUser) {
      if (newUpdates.length > 0) {
        await manualUser.send(`✅ Comprobación finalizada. Te envié **${newUpdates.length}** alerta(s) nueva(s).`);
      } else {
        await manualUser.send('🔍 Comprobación finalizada. No tienes notificaciones nuevas en MIeL.');
      }
    }

  } catch (error) {
    console.error('Error al comprobar actualizaciones de MIeL:', error);
    consecutiveFailures++;

    if (consecutiveFailures >= 3 || manualUser) {
      const notifiedUser = manualUser || (DISCORD_USER_ID ? await client.users.fetch(DISCORD_USER_ID).catch(() => null) : null);
      if (notifiedUser) {
        await notifiedUser.send(
          `⚠️ **Alerta del Bot**: Se han producido ${consecutiveFailures} fallo(s) consecutivo(s) al intentar verificar tu cuenta de MIeL.\n` +
          `**Detalle del error:** \`${error.message}\`\n` +
          `Por favor, verifica que tu DNI y clave sean válidos y que el servidor de MIeL esté operativo.`
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

  const db = loadDatabase();
  if (db.lastCheckTime && !lastCheckTime) {
    lastCheckTime = new Date(db.lastCheckTime);
  }

  client.user.setActivity('novedades de MIeL', { type: ActivityType.Watching });

  await registerCommands();

  if (DISCORD_USER_ID) {
    const owner = await client.users.fetch(DISCORD_USER_ID).catch(() => null);
    if (owner) {
      await owner.send(
        '👋 ¡Hola! El bot de **MIeL Notificador** se ha iniciado correctamente.\n' +
        '• Monitoreando: **Mensajes, Foros, Contenidos, Portafolio, Evaluaciones, Encuestas y Novedades**.\n' +
        '• Usa `/check` para revisar ahora mismo o `/materias` para ver tus comisiones activas.'
      ).catch(() => {});
    }
  }

  console.log(`⏰ Programando verificación automática con la expresión cron: "${CHECK_INTERVAL_CRON}"`);
  cron.schedule(CHECK_INTERVAL_CRON, () => {
    performCheck().catch(err => console.error('Error en tarea programada:', err));
  });
});

// Evento InteractionCreate (Comandos Slash)
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

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
        return;
      }

      isChecking = true;

      try {
        const credentials = { usuario: MIEL_DNI, clave: MIEL_PASSWORD };
        const headless = PLAYWRIGHT_HEADLESS !== 'false';

        const allUpdates = await checkMielUpdates(credentials, headless);
        lastCheckTime = new Date();
        consecutiveFailures = 0;

        const newUpdates = allUpdates.filter(u => !hasBeenNotified(u.id));
        const pendingUnread = allUpdates.filter(u => hasBeenNotified(u.id) && u.isExplicitUnread);

        // Caso 1: Hay novedades nuevas sin notificar
        if (newUpdates.length > 0) {
          const embed = {
            color: 0xffa500,
            title: `📥 Nuevas novedades detectadas en MIeL (${newUpdates.length})`,
            url: 'https://miel.unlam.edu.ar/principal/interno/',
            description: 'Se encontraron las siguientes actualizaciones nuevas en tus materias:',
            fields: buildSummaryFields(newUpdates),
            footer: {
              text: newUpdates.length > 10
                ? `Mostrando 10 de ${newUpdates.length} novedades nuevas · MIeL Notificador`
                : 'MIeL Notificador · UNLaM'
            },
            timestamp: new Date().toISOString()
          };

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel('Ir a MIeL')
              .setStyle(ButtonStyle.Link)
              .setURL(newUpdates[0].url || 'https://miel.unlam.edu.ar/principal/interno/')
          );

          await interaction.editReply({
            content: `✅ **¡Comprobación finalizada!** Se detectaron **${newUpdates.length}** novedad(es) nueva(s):`,
            embeds: [embed],
            components: [row]
          }).catch(() => {});

          markMultipleAsNotified(newUpdates.map(u => u.id));
          return;
        }

        // Caso 2: No hay novedades nuevas, pero siguen existiendo mensajes o foros con badge rojo sin abrir en MIeL
        if (pendingUnread.length > 0) {
          const embed = {
            color: 0x3498db,
            title: `🔔 Pendientes sin abrir en MIeL (${pendingUnread.length})`,
            url: 'https://miel.unlam.edu.ar/principal/interno/',
            description: 'No hubo publicaciones nuevas desde la última revisión, pero **todavía tienes estos ítems marcados como no leídos** en MIeL:',
            fields: buildSummaryFields(pendingUnread),
            footer: {
              text: 'Cuando los abras en MIeL, dejarán de aparecer como pendientes.'
            },
            timestamp: new Date().toISOString()
          };

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel('Abrir pendiente en MIeL')
              .setStyle(ButtonStyle.Link)
              .setURL(pendingUnread[0].url || 'https://miel.unlam.edu.ar/principal/interno/')
          );

          await interaction.editReply({
            content: '🔍 **Sin novedades nuevas**, pero tienes pendientes sin leer en la plataforma:',
            embeds: [embed],
            components: [row]
          }).catch(() => {});
          return;
        }

        // Caso 3: Todo completamente al día
        await interaction.editReply('✅ **Todo al día:** No tienes notificaciones nuevas ni mensajes/foros pendientes sin leer en ninguna materia de MIeL.').catch(() => {});

      } catch (error) {
        console.error('Error en comprobación manual:', error);
        consecutiveFailures++;
        await interaction.editReply(`❌ Ocurrió un error al verificar MIeL: \`${error.message}\``).catch(() => {});
      } finally {
        isChecking = false;
      }
    }

    else if (commandName === 'materias') {
      const db = loadDatabase();
      const subjects = db.lastSubjects || [];

      if (subjects.length === 0) {
        return interaction.reply({
          content: 'ℹ️ Aún no hay un relevamiento de materias guardado. Ejecuta `/check` para escanear tu cuenta de MIeL.',
          ephemeral: true
        }).catch(() => {});
      }

      const fields = subjects.map(s => {
        const badgeEntries = Object.entries(s.badges || {});
        const badgeText = badgeEntries.length > 0
          ? badgeEntries.map(([sec, count]) => `🔴 **${sec.toUpperCase()}**: ${count} sin leer`).join(' · ')
          : '🟢 Sin alertas pendientes en el tablero';

        return {
          name: `📘 ${s.name}`,
          value: `Comisión ID: \`${s.comisionId}\` · ${badgeText}`,
          inline: false
        };
      });

      const materiasEmbed = {
        color: 0x2ecc71,
        title: `🎓 Materias Activas Monitoreadas (${subjects.length})`,
        url: 'https://miel.unlam.edu.ar/principal/interno/',
        description: 'Estado de tus comisiones según la última verificación realizada:',
        fields,
        footer: {
          text: db.lastCheckTime
            ? `Última actualización: ${new Date(db.lastCheckTime).toLocaleString()}`
            : 'MIeL Notificador'
        },
        timestamp: new Date().toISOString()
      };

      await interaction.reply({ embeds: [materiasEmbed] }).catch(() => {});
    }

    else if (commandName === 'status') {
      const db = loadDatabase();
      const effectiveLastCheck = lastCheckTime || (db.lastCheckTime ? new Date(db.lastCheckTime) : null);

      const statusEmbed = {
        color: 0x00ae86,
        title: '📊 Estado del Bot de MIeL',
        fields: [
          { name: '🕒 Última Comprobación', value: effectiveLastCheck ? effectiveLastCheck.toLocaleString() : 'Nunca', inline: true },
          { name: '🎓 Materias Monitoreadas', value: `${(db.lastSubjects || []).length} comisiones`, inline: true },
          { name: '🗂️ Secciones Inicializadas', value: `${(db.seededSections || []).length} secciones`, inline: true },
          { name: '🔔 Historial Registrado', value: `${db.notifiedIds.length} ítems en memoria`, inline: true },
          { name: '⚠️ Fallas Consecutivas', value: `${consecutiveFailures}`, inline: true },
          { name: '⚙️ Estado Actual', value: isChecking ? '🔄 Buscando novedades...' : '✅ En espera', inline: true },
          { name: '⏰ Intervalo Automático', value: `Cron: \`${CHECK_INTERVAL_CRON}\``, inline: false }
        ],
        timestamp: new Date().toISOString()
      };
      await interaction.reply({ embeds: [statusEmbed] }).catch(() => {});
    }

    else if (commandName === 'help') {
      const helpEmbed = {
        color: 0x3498db,
        title: '❓ Ayuda — MIeL Notificador',
        description:
          'Este bot inicia sesión en tu cuenta de MIeL de manera programada y monitorea cambios en todas tus materias:\n' +
          '• ✉️ **Mensajería** (mensajes no leídos y aviso de adjuntos)\n' +
          '• 💬 **Foros** (conteo exacto de mensajes sin leer y nuevos temas)\n' +
          '• 📚 **Contenidos** (nuevos apuntes, PDFs o links subidos por la cátedra)\n' +
          '• 💼 **Portafolio** (nuevos trabajos prácticos, entregas y correcciones/notas)\n' +
          '• 📝 **Evaluaciones y Encuestas**\n' +
          '• 📢 **Novedades Institucionales de UNLaM**',
        fields: [
          { name: '`/check`', value: 'Fuerza una revisión inmediata de MIeL. Muestra las novedades nuevas y también te recuerda si dejaste algún mensaje o foro sin abrir.' },
          { name: '`/materias`', value: 'Lista todas tus materias activas del cuatrimestre y si alguna tiene burbujas rojas de notificación en MIeL.' },
          { name: '`/status`', value: 'Muestra estadísticas de la base de datos, secciones monitoreadas y última revisión.' },
          { name: '`/help`', value: 'Muestra este mensaje de ayuda.' }
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
