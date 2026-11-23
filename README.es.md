<p align="center"><img src="publisher/public/logo.png" width="80" alt="Kaggle Studio"></p>
<h1 align="center">Kaggle Studio</h1>
<p align="center"><a href="README.md" lang="zh-CN">中文</a> · <a href="README.en.md" lang="en">English</a> · <a href="README.fr.md" lang="fr">Français</a> · <a href="README.ru.md" lang="ru">Русский</a> · <a href="README.es.md" lang="es">Español</a> · <a href="README.ar.md" lang="ar" dir="rtl">العربية</a></p>
<p align="center">Cambia de modelo. Inicia y detén sesiones. Desde el móvil.</p>

Reúne tus propios modelos de conversación, imágenes y vídeo en una aplicación Android. Autoriza Cloudflare e introduce tu token de API de Kaggle para encontrar una instalación existente o preparar un despliegue personal.

## Tu móvil es el panel de control

- **Cambia de modelo seleccionándolo:** elige un modelo ya desplegado de la lista. Studio gestiona la finalización de la sesión anterior y la carga del modelo elegido.
- **Inicia la GPU cuando la necesites:** inicia una sesión de Kaggle desde Compute y sigue el estado de carga en la aplicación.
- **Detén sesiones aunque estés lejos del ordenador:** solicita la detención desde el móvil y comprueba que Kaggle confirme el fin de la sesión. La gestión diaria no requiere ordenador, escritorio remoto ni línea de comandos.

El cambio no es instantáneo: Studio espera a que termine la sesión anterior y después carga el modelo seleccionado. Solo se ejecuta un modelo en GPU a la vez.

## Funciones

| Área | Funciones |
|---|---|
| Conversación | Modelos GGUF, conversaciones largas y representación de fórmulas matemáticas; los modelos de visión compatibles admiten fotos y preguntas sobre imágenes |
| Imágenes | Perfiles SDXL y Z-Image; generación a partir de texto o de una imagen de referencia |
| Vídeo | Perfiles Wan; generación a partir de texto y, con modelos compatibles, de imágenes |
| Despliegue personal | Worker, D1, Tunnel privado y servicio VPC en tu cuenta de Cloudflare, con tu propia dirección workers.dev |
| Gestión | Reutilizar una instalación, reparar el código del gestor, actualizar tokens y modelos, retirar la autorización de un dispositivo o eliminar un despliegue verificado |

## Primeros pasos

1. Descarga el APK desde el [sitio web](https://studio.entropy1221.cc.cd) e instálalo en Android 8.0 o posterior.
2. Inicia sesión en Cloudflare y autoriza tu propia cuenta.
3. Introduce tu token de API de Kaggle. Realiza en Kaggle la verificación telefónica que se requiera.
4. Elige los modelos y conecta una instalación existente o crea tu propio despliegue.
5. Cuando termine el despliegue, entra en Studio, inicia una sesión en Compute y espera a que el modelo esté listo.

El APK oficial no exige que cada usuario registre un cliente OAuth ni disponga de un dominio propio. Los recursos de la nube permanecen en las cuentas del usuario; el historial y los archivos multimedia se guardan en el dispositivo.

## Estructura del repositorio

| Directorio | Contenido |
|---|---|
| `android/` | Contenedor nativo de Android, almacenamiento cifrado, puente de red e interfaz React |
| `manager/` | Gestor de Cloudflare, esquemas de base de datos y entorno de ejecución de Kaggle |
| `shared/` | Perfiles de modelos, ajustes de contexto y comprobaciones de identidad del Notebook |
| `publisher/` | Recursos y plantilla de página del sitio |
| `scripts/`, `tests/` | Herramientas de compilación y comprobaciones locales |

Consulta la [arquitectura](docs/architecture.md), el [desarrollo](docs/development.md) y la [publicación](docs/publishing.md). Las guías técnicas detalladas están actualmente en chino. Las traducciones del README no añaden idiomas a la interfaz de la aplicación.

## Credenciales y recursos

- La configuración de Cloudflare utiliza PKCE. El token de Kaggle se guarda como Secret en tu Worker; las solicitudes diarias utilizan claves del dispositivo.
- Retirar la autorización de un dispositivo no elimina otros dispositivos ni cambia las claves de servicio originales.
- **Repair manager program only** actualiza el Worker existente y conserva el Notebook, la configuración, los registros de sesiones y los secretos.
- Eliminar un despliegue requiere comprobar su titularidad y su nombre exacto. Desinstalar la aplicación no detiene sesiones GPU ni elimina recursos de la nube.
- El repositorio no incluye claves de firma, tokens personales, bases de datos de usuarios, registros de ejecución ni pesos de modelos. El Client ID de OAuth del editor es un identificador público de aplicación, no una clave secreta de cuenta.

## Validación y límites de los modelos

Kaggle controla el acceso a GPU, la verificación telefónica, las cuotas y la disponibilidad. Las funciones y los requisitos de memoria dependen del modelo. Un despliegue completado no garantiza una inferencia correcta.

Las comprobaciones locales cubren recuperación de autorización, reutilización de instalaciones, estado de detención, retirada de autorización de dispositivos, tareas en segundo plano, fórmulas y flujos de interfaz. Las pruebas de imágenes y vídeo también verifican parámetros y resultados numéricos inválidos. Las pruebas simuladas no demuestran la calidad de imagen, la capacidad de memoria ni el rendimiento de una T4 real; comprueba estos aspectos en tu hardware.

Los pesos y las dependencias mantienen sus respectivas licencias. Consulta los [avisos de terceros](android/web/public/third-party-notices.txt).

Proyecto independiente, sin afiliación ni respaldo oficial de Cloudflare, Kaggle, Google o los editores de modelos.
