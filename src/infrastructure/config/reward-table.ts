/**
 * Reward table del cofre de HU-22 (Management #69), version 1.
 *
 * Copia EMBEBIDA de docs/contracts/hu-22-reward-table-v1.json en
 * Nexus-Battle-Infrastructure (auditado 2026-09-22, GET https://nexus.simuladorupbbga.app/api/v1/catalog/products (paginado completo, 84 productos)).
 * Cada repositorio consumidor guarda su propia copia -- igual que la tabla
 * de efectos de HU-25 vive en Combat, no se consulta a Infrastructure en
 * tiempo de ejecucion. Cambiar esta tabla es una nueva version del JSON
 * fuente, replicada aqui a mano, nunca una edicion silenciosa de un lado.
 *
 * Rangos CONTIGUOS sobre el mismo espacio de 8000 filas que
 * EffectControlTable (HU-25, RandomIndex.MAX): 300 filas por ARMADURA
 * (60%), 150 por ARMA (30%), 100 por ITEM (10%). Exclusiones del pool
 * (HEROE, EPICA, premium, stock LIMITED, HABILIDAD): decision del proyecto,
 * no de este archivo -- ver el contrato.
 */

import { RewardTable } from '../../domain/reward/RewardTable'

export interface RewardTableEntryConfig {
  readonly firstRow: number
  readonly lastRow: number
  readonly tierId: string
  readonly productId: string
  readonly sku: string
  readonly name: string
}

export const REWARD_TABLE_SCHEMA_VERSION = '1'
export const REWARD_TABLE_ROWS = 8000

export const REWARD_TABLE_ENTRIES: readonly RewardTableEntryConfig[] = [
  {
    firstRow: 1,
    lastRow: 300,
    tierId: 'COMUN',
    productId: '45554d1c-8728-44ee-bdfc-287e87801098',
    sku: 'atadura-carmesi-45554d1c',
    name: 'Atadura carmesí',
  },
  {
    firstRow: 301,
    lastRow: 600,
    tierId: 'COMUN',
    productId: '94002b15-496e-490c-b413-8a4855319701',
    sku: 'bata-de-cirujano-94002b15',
    name: 'Bata de Cirujano',
  },
  {
    firstRow: 601,
    lastRow: 900,
    tierId: 'COMUN',
    productId: '69183910-7105-487c-ab64-c2b5d23cf15f',
    sku: 'casco-de-ecos-ancestrales-69183910',
    name: 'Casco de Ecos Ancestrales',
  },
  {
    firstRow: 901,
    lastRow: 1200,
    tierId: 'COMUN',
    productId: '315d6197-0acb-4359-a3f3-47d6931e5741',
    sku: 'caida-de-fuego-315d6197',
    name: 'Caída de fuego',
  },
  {
    firstRow: 1201,
    lastRow: 1500,
    tierId: 'COMUN',
    productId: '6a96d059-88c1-4702-8f07-8410f98707a3',
    sku: 'corona-de-hielo-6a96d059',
    name: 'Corona de hielo',
  },
  {
    firstRow: 1501,
    lastRow: 1800,
    tierId: 'COMUN',
    productId: '6254a686-61db-44f8-b58a-f4506a1dbcb4',
    sku: 'defensa-del-enfurecido-6254a686',
    name: 'Defensa del enfurecido',
  },
  {
    firstRow: 1801,
    lastRow: 2100,
    tierId: 'COMUN',
    productId: 'e36f7f9c-ee45-40dc-a2dc-33da4d9bdd12',
    sku: 'magma-ardiente-e36f7f9c',
    name: 'Magma Ardiente',
  },
  {
    firstRow: 2101,
    lastRow: 2400,
    tierId: 'COMUN',
    productId: 'f506d7d5-d1cc-49b7-b458-cc1d32d1cf6e',
    sku: 'mano-del-desterrado-f506d7d5',
    name: 'Mano del desterrado',
  },
  {
    firstRow: 2401,
    lastRow: 2700,
    tierId: 'COMUN',
    productId: 'f75ad91e-bd41-43e5-97f5-dfb313c56bac',
    sku: 'pantalon-de-expedicion-medica-f75ad91e',
    name: 'Pantalón de Expedición Médica',
  },
  {
    firstRow: 2701,
    lastRow: 3000,
    tierId: 'COMUN',
    productId: '796af8f4-29fc-4944-9355-dae8aa8ae967',
    sku: 'pie-de-atleta-796af8f4',
    name: 'Pie de atleta',
  },
  {
    firstRow: 3001,
    lastRow: 3300,
    tierId: 'COMUN',
    productId: 'bfeb146d-6b9a-4aea-a744-07aebc9e7133',
    sku: 'piel-de-caminante-del-bosque-bfeb146d',
    name: 'Piel de Caminante del Bosque',
  },
  {
    firstRow: 3301,
    lastRow: 3600,
    tierId: 'COMUN',
    productId: '2aadc743-1419-440f-b853-86bf2bcb3af3',
    sku: 'puno-lucido-2aadc743',
    name: 'Puño lúcido',
  },
  {
    firstRow: 3601,
    lastRow: 3900,
    tierId: 'COMUN',
    productId: '6c7ccc47-306b-433c-b7ba-9775a0573570',
    sku: 'punos-en-llamas-6c7ccc47',
    name: 'Puños en llamas',
  },
  {
    firstRow: 3901,
    lastRow: 4200,
    tierId: 'COMUN',
    productId: 'ab73fd8d-7e68-4606-838b-1caa2acb02eb',
    sku: 'sangre-cruel-ab73fd8d',
    name: 'Sangre cruel',
  },
  {
    firstRow: 4201,
    lastRow: 4500,
    tierId: 'COMUN',
    productId: '0dcf74f0-42a1-48c7-994d-ddd26c8f4d42',
    sku: 'tunica-arcana-0dcf74f0',
    name: 'Túnica arcana',
  },
  {
    firstRow: 4501,
    lastRow: 4800,
    tierId: 'COMUN',
    productId: '234c804b-94cc-411d-8cad-24eb1b9bd6f9',
    sku: 'ventisca-234c804b',
    name: 'Ventisca',
  },
  {
    firstRow: 4801,
    lastRow: 4950,
    tierId: 'RARA',
    productId: '095844e1-0b37-49d4-a4c0-c150504892e4',
    sku: 'baculo-de-permafrost-095844e1',
    name: 'Báculo de Permafrost',
  },
  {
    firstRow: 4951,
    lastRow: 5100,
    tierId: 'RARA',
    productId: 'c846ae38-7a57-4d59-85e2-573e0c1a3d69',
    sku: 'cierra-sangrienta-c846ae38',
    name: 'Cierra sangrienta',
  },
  {
    firstRow: 5101,
    lastRow: 5250,
    tierId: 'RARA',
    productId: '1bc8da4f-5081-4d0e-84a6-5a5e1ac1b665',
    sku: 'daga-purulenta-1bc8da4f',
    name: 'Daga purulenta',
  },
  {
    firstRow: 5251,
    lastRow: 5400,
    tierId: 'RARA',
    productId: 'eca786b7-5b32-462f-b5fe-159faca92af5',
    sku: 'escudo-de-dragon-eca786b7',
    name: 'Escudo de dragón',
  },
  {
    firstRow: 5401,
    lastRow: 5550,
    tierId: 'RARA',
    productId: 'eca65350-adcb-4452-a9a1-f2b2b756abcc',
    sku: 'espada-de-dos-manos-eca65350',
    name: 'Espada de dos manos',
  },
  {
    firstRow: 5551,
    lastRow: 5700,
    tierId: 'RARA',
    productId: 'e94527a7-6392-4776-961a-66e9b210b9ff',
    sku: 'espada-de-una-mano-e94527a7',
    name: 'Espada de una mano',
  },
  {
    firstRow: 5701,
    lastRow: 5850,
    tierId: 'RARA',
    productId: 'f9c7ee97-ee1c-4683-8ff3-7f67a0c1b52c',
    sku: 'fuego-fatuo-f9c7ee97',
    name: 'Fuego fatuo',
  },
  {
    firstRow: 5851,
    lastRow: 6000,
    tierId: 'RARA',
    productId: '530070bb-7677-470e-afa5-4c184662b957',
    sku: 'kit-de-urgencias-530070bb',
    name: 'Kit de urgencias',
  },
  {
    firstRow: 6001,
    lastRow: 6150,
    tierId: 'RARA',
    productId: 'aa5833c8-86e0-4c02-850f-1e2017927829',
    sku: 'machete-vendito-aa5833c8',
    name: 'Machete vendito',
  },
  {
    firstRow: 6151,
    lastRow: 6300,
    tierId: 'RARA',
    productId: 'a9e279fd-a324-4083-a2f3-ae8e0be379be',
    sku: 'orbe-de-manos-ardientes-a9e279fd',
    name: 'Orbe de manos ardientes',
  },
  {
    firstRow: 6301,
    lastRow: 6450,
    tierId: 'RARA',
    productId: 'cf1d645a-8f57-422b-b0bf-db4192f5d3d8',
    sku: 'piedra-de-afilar-cf1d645a',
    name: 'Piedra de afilar',
  },
  {
    firstRow: 6451,
    lastRow: 6600,
    tierId: 'RARA',
    productId: 'f25f2096-621e-4d8b-aeae-64431e83eb0c',
    sku: 'raiz-china-f25f2096',
    name: 'Raíz china',
  },
  {
    firstRow: 6601,
    lastRow: 6750,
    tierId: 'RARA',
    productId: '7918f5a5-7b07-4ea9-a090-db9e419926b2',
    sku: 'reanimador-7918f5a5',
    name: 'Reanimador',
  },
  {
    firstRow: 6751,
    lastRow: 6900,
    tierId: 'RARA',
    productId: 'ae400acc-aed3-4870-87a6-560f3994f60c',
    sku: 'venas-heladas-ae400acc',
    name: 'Venas heladas',
  },
  {
    firstRow: 6901,
    lastRow: 7050,
    tierId: 'RARA',
    productId: '739df0cc-bd87-4692-9b7c-eb3b8e85eec1',
    sku: 'vision-borrosa-739df0cc',
    name: 'Visión borrosa',
  },
  {
    firstRow: 7051,
    lastRow: 7200,
    tierId: 'RARA',
    productId: '076fc7b3-9bfa-4d48-a960-446f1bdd3041',
    sku: 'yerbabuena-076fc7b3',
    name: 'Yerbabuena',
  },
  {
    firstRow: 7201,
    lastRow: 7300,
    tierId: 'ESPECIAL',
    productId: '173c96e2-cfae-40a6-b9d0-066b92721fc1',
    sku: 'anillo-para-piro-explosion-173c96e2',
    name: 'Anillo para Piro-explosión',
  },
  {
    firstRow: 7301,
    lastRow: 7400,
    tierId: 'ESPECIAL',
    productId: '01a3a9f0-3dc9-43d1-a8b5-258995bf62cf',
    sku: 'benditas-01a3a9f0',
    name: 'Benditas',
  },
  {
    firstRow: 7401,
    lastRow: 7500,
    tierId: 'ESPECIAL',
    productId: '176c1c30-d7ec-4088-a041-d251955ec60c',
    sku: 'empunadura-de-furia-176c1c30',
    name: 'Empuñadura de Furia',
  },
  {
    firstRow: 7501,
    lastRow: 7600,
    tierId: 'ESPECIAL',
    productId: '6e70fa14-fdb2-4593-a7e0-110c7e2d32ba',
    sku: 'libro-de-la-ventisca-helada-6e70fa14',
    name: 'Libro de la ventisca helada',
  },
  {
    firstRow: 7601,
    lastRow: 7700,
    tierId: 'ESPECIAL',
    productId: 'bcaa42c0-af23-4e84-a148-623037d76f05',
    sku: 'mancuerna-yugular-bcaa42c0',
    name: 'Mancuerna yugular',
  },
  {
    firstRow: 7701,
    lastRow: 7800,
    tierId: 'ESPECIAL',
    productId: '94fddf73-3f0b-41c0-af3c-4cc89cad7977',
    sku: 'pinchos-de-escudo-94fddf73',
    name: 'Pinchos de escudo',
  },
  {
    firstRow: 7801,
    lastRow: 7900,
    tierId: 'ESPECIAL',
    productId: '89b56f05-97ca-4826-baf5-6bea98c36381',
    sku: 'pluma-sanadora-89b56f05',
    name: 'Pluma sanadora',
  },
  {
    firstRow: 7901,
    lastRow: 8000,
    tierId: 'ESPECIAL',
    productId: 'c4d0626d-71d7-4c43-8c4d-f9deb994c481',
    sku: 'veneno-lacerante-c4d0626d',
    name: 'Veneno lacerante',
  },
]

/**
 * Construye la `RewardTable` de dominio a partir de `REWARD_TABLE_ENTRIES`.
 * `RewardTable.fromRanges` valida por construccion que los 40 tramos cubren
 * exactamente `1..8000` sin huecos ni solapes: un error aqui (una entrada mal
 * copiada) hace fallar el arranque en lugar de sortear con una tabla rota.
 */
export const buildRewardTable = (): RewardTable =>
  RewardTable.fromRanges(
    REWARD_TABLE_ENTRIES.map((config) => ({
      firstRow: config.firstRow,
      lastRow: config.lastRow,
      entry: {
        productId: config.productId,
        sku: config.sku,
        name: config.name,
        tierId: config.tierId,
      },
    })),
  )
