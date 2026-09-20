// Orquestador del estudio de HU-26: compila el harness, genera las muestras con
// el codigo productivo y ejecuta el analisis estadistico offline.
//
//   npm run study:hu-26
//
// Requiere el entorno Python de tools/hu-26/requirements.txt (ver ese fichero).
// No forma parte del runtime de Combat ni de la CI normal.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const run = (command, args, label) => {
  process.stdout.write(`\n== ${label}\n`)
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true })

  if (result.status !== 0) {
    process.stderr.write(`Fallo en "${label}" (codigo ${String(result.status)}).\n`)
    process.exit(result.status ?? 1)
  }
}

const venv = join('tools', 'hu-26', '.venv')
const candidates = [join(venv, 'Scripts', 'python.exe'), join(venv, 'bin', 'python')]
const python = candidates.find((path) => existsSync(path)) ?? 'python'

run(
  'npm',
  ['run', 'study:hu-26:build'],
  '1/3 compilar el harness (codigo productivo + tools/hu-26)',
)
run('npm', ['run', 'study:hu-26:samples'], '2/3 generar muestras con createNormalSequence / create')
run(`"${python}"`, [join('tools', 'hu-26', 'analyze.py')], '3/3 analisis estadistico offline')
