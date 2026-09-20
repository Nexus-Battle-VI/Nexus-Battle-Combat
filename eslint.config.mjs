// @ts-check
import { defineConfig, globalIgnores } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * ESLint 10 con reglas basadas en informacion de tipos.
 *
 * Este servicio usa TypeScript 5.9 porque el Nest CLI 11 depende de esa version
 * de forma directa. Vease ADR-002 en Nexus-Battle-Infrastructure.
 */
export default defineConfig([
  globalIgnores([
    'dist/**',
    'coverage/**',
    'node_modules/**',
    'tools/hu-26/.venv/**',
    'tools/hu-26/.build/**',
    'tools/hu-26/.samples/**',
    // Orquestador CLI en JavaScript plano (no forma parte del proyecto TypeScript).
    'tools/hu-26/*.mjs',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  prettier,

  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      'no-console': 'error',
      // Los decoradores de Nest y class-validator introducen efectos que las
      // reglas de tipos no pueden modelar; se acotan a las capas exteriores.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },

  // El dominio no puede depender de NestJS, SDK, ORM, HTTP ni drivers de base de datos.
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@nestjs/*',
                '@aws-sdk/*',
                'aws-sdk',
                'express',
                'node:http',
                'node:https',
                'pg',
                'mongodb',
                'mongoose',
                'typeorm',
                '@prisma/*',
                'class-validator',
                'class-transformer',
                'rxjs',
                '**/adapters/**',
                '**/infrastructure/**',
                '**/application/**',
              ],
              message:
                'El dominio no puede importar NestJS, SDK, ORM, HTTP, drivers, adaptadores ni la capa de aplicacion. Un error de regla de negocio que el propio agregado puede determinar por si mismo se define como subclase de DomainError en domain/errors/; application/errors es solo para lo que depende de orquestacion/persistencia (ver domain/errors/BattleRoomErrors.ts).',
            },
          ],
        },
      ],
    },
  },

  // La capa de aplicacion depende de sus puertos, no de adaptadores ni del framework.
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@nestjs/core',
                '@nestjs/platform-express',
                '@nestjs/swagger',
                'express',
                'pg',
                'typeorm',
                '@prisma/*',
                '**/adapters/**',
                '**/infrastructure/**',
              ],
              message:
                'La capa de aplicacion solo depende de sus puertos y del dominio. La composicion ocurre en infrastructure/bootstrap.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['test/**/*.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },

  {
    files: ['src/infrastructure/observability/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
])
