# Banco ampliado de preguntas HAREC — guía de importación

## Archivos

- `banco_practica_harec_2026_ampliado.json`: banco de preguntas listo para procesar desde el backend.

## Contenido

- **1.049 preguntas originales**.
- **702** de Electricidad y Radioelectricidad.
- **347** de Reglamentación y Manejo.
- Cuatro alternativas por pregunta y una única respuesta correcta.
- Explicación didáctica asociada a cada respuesta.
- Categoría, tema, dificultad y etiquetas para filtros.
- Referencias a las fuentes o temarios de cada pregunta.

El PDF se utilizó como guía temática general. Este fichero no es una transcripción ni una reformulación pregunta por pregunta del libro: las preguntas se redactaron de forma independiente. Por ello, no debe interpretarse como una reproducción de las 418 preguntas-respuestas listadas en el índice del libro.

## Estructura JSON

El objeto raíz contiene:

- `schemaVersion`: versión del esquema.
- `metadata`: título, idioma, fecha, cantidad de preguntas, configuración sugerida, avisos normativos y catálogo de referencias.
- `sections`: las dos áreas principales del banco.
- `questions`: colección de preguntas.

Cada elemento de `questions` contiene:

| Campo | Uso |
|---|---|
| `id` | Identificador estable y único. |
| `section` | Identificador de la sección principal. |
| `category` | Categoría para filtrar. |
| `topic` | Tema concreto. |
| `difficulty` | `basico`, `intermedio` o `avanzado`. |
| `question` | Enunciado. |
| `type` | Actualmente `single_choice`. |
| `options` | Cuatro opciones con `id` y `text`. |
| `correctOptionId` | ID de la opción correcta. |
| `explanation` | Explicación que se puede mostrar después de responder. |
| `tags` | Etiquetas para búsqueda y selección. |
| `sourceRefs` | Referencias del catálogo `metadata.references`. |

## Configuración de examen incluida

`metadata.defaultExamSettings` propone un examen de 10 preguntas, con 5 de cada sección, orden aleatorio de preguntas y alternativas, y explicación cuando la respuesta sea incorrecta. La aplicación puede sobrescribir estos valores al crear cada examen.

## Importación recomendada en Firestore

Crear una colección `questionBank` y guardar cada pregunta en un documento cuyo ID sea el propio `id`:

```text
questionBank/ELE-001
questionBank/REG-001
questionBank/HRC-00061
```

La importación se puede ejecutar una vez desde un script de backend con Firebase Admin SDK. Conviene usar escrituras por lotes y controlar el tamaño de cada lote según los límites de Firestore. Guardar `metadata` y `sections` por separado, por ejemplo en documentos de configuración, evita repetirlos en cada pregunta.

## Importante: proteger las respuestas correctas

Este JSON incluye `correctOptionId` porque es un fichero de importación. **No conviene enviar ese campo al navegador antes de que el usuario responda**, ya que cualquiera podría inspeccionar la respuesta correcta.

Para una implementación segura:

1. El backend selecciona las preguntas y devuelve `id`, `section`, `category`, `topic`, `difficulty`, `question`, `options` y los metadatos que necesite la interfaz, pero omite `correctOptionId` y `explanation`.
2. El frontend envía al backend el `questionId` y el `selectedOptionId`.
3. El backend comprueba la respuesta y devuelve si es correcta; si es incorrecta, devuelve la explicación y, si se desea, la alternativa correcta.
4. La clave de respuestas permanece en el backend o en una colección no accesible directamente por los clientes.

Firestore no ofrece reglas de seguridad por campo dentro de un mismo documento. Por eso, si se usa Firestore, es preferible separar el contenido público de la clave privada o servir las preguntas a través de un endpoint autenticado.

## Aviso de normativa

Las preguntas normativas incluyen referencias y fecha de corte de 15-11-2026. La reglamentación puede cambiar: antes de utilizar este banco como preparación definitiva, revisa las disposiciones vigentes en el BOE y las indicaciones de la Administración. Las preguntas técnicas y de operación también deben revisarse periódicamente para detectar erratas o ambigüedades.
