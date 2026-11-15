# Importación del banco de preguntas HAREC

## Formato

El fichero `banco_practica_harec.json` es un JSON UTF-8. Es adecuado para cargarlo en un backend, procesarlo en Angular o importar sus registros en Firestore.

## Estructura de cada pregunta

- `id`: identificador estable de la pregunta.
- `section`: bloque del examen (`electricidad_radioelectricidad` o `reglamentacion_manejo`).
- `category` y `topic`: clasificación para filtros y estadísticas.
- `difficulty`: nivel orientativo (`basico`, `intermedio` o `avanzado`).
- `question`: enunciado.
- `options`: cuatro opciones, cada una con `id` y `text`.
- `correctOptionId`: identificador de la opción correcta.
- `explanation`: explicación que se muestra cuando la respuesta es incorrecta.
- `tags`: etiquetas útiles para búsquedas y selección de preguntas.
- `sourceRefs`: referencias temáticas o normativas asociadas.

## Configuración inicial recomendada

El propio JSON incluye `metadata.defaultExamSettings`: 10 preguntas por examen, cuatro alternativas, orden aleatorio de preguntas y opciones, y explicación solo cuando se falla. En modo mixto recomienda seleccionar 5 preguntas de cada bloque.

## Lógica de corrección

1. Seleccionar las preguntas según las materias elegidas.
2. Crear una copia de cada pregunta y mezclar `options` sin modificar sus identificadores.
3. Al responder, comparar el identificador elegido con `correctOptionId`.
4. Si no coincide, mostrar `explanation`.
5. No guardar la respuesta correcta en el estado visible del cliente antes de corregir si se quiere evitar que sea accesible desde las herramientas del navegador; para exámenes evaluables, servir la corrección desde el backend.

## Nota sobre el contenido

El banco contiene 60 preguntas originales: 30 de electricidad/radioelectricidad y 30 de reglamentación/manejo. No es una extracción ni una reproducción de las preguntas del libro enlazado. Las preguntas normativas se deben contrastar con la legislación y las instrucciones oficiales vigentes antes de utilizarse como material definitivo de preparación.
