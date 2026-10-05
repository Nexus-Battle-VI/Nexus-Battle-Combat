import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'

import type { BattleRoom } from '../../../domain/entities/BattleRoom'
import { BattleMode } from '../../../domain/value-objects/BattleMode'
import { BattleRoomStatus } from '../../../domain/value-objects/BattleRoomStatus'
import type { BattleDropInventoryPort } from '../../../application/ports/BattleDropInventoryPort'
import type { BattleDropNotificationPort } from '../../../application/ports/BattleDropNotificationPort'
import type { BattleDropWorkflowRepositoryPort } from '../../../application/ports/BattleDropWorkflowRepositoryPort'
import { battleDropWorkflowId } from '../../../application/ports/BattleDropWorkflowRepositoryPort'
import type { BattleHeroCommitmentPort } from '../../../application/ports/BattleHeroCommitmentPort'
import type { BattleRoomRepositoryPort } from '../../../application/ports/BattleRoomRepositoryPort'
import { battleDropEvents } from '../../../application/services/BattleDropState'
import type { Logger } from '../../../infrastructure/observability/logger'

/**
 * Reconcilia decisiones YA persistidas en eventos. Nunca sortea aquí. Hasta
 * FINISHED solo crea el derecho; después transfiere cada instancia con un
 * operationId derivado de battleId/seq y cierra la reserva al completar todo.
 */
export class IntervalBattleDropScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly workflows: BattleDropWorkflowRepositoryPort,
    private readonly inventory: BattleDropInventoryPort,
    private readonly commitments: BattleHeroCommitmentPort,
    private readonly notifications: BattleDropNotificationPort,
    private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.tick()
    this.timer = setInterval(() => void this.tick(), 2_000)
    this.timer.unref()
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const active = await this.rooms.findInBattle()
      const finished = await this.rooms.findFinishedSince(
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      )
      const due = await this.workflows.findUnsettled(50)
      const roomsById = new Map([...active, ...finished].map((room) => [room.id, room]))
      for (const workflow of due) {
        if (roomsById.has(workflow.battleId)) continue
        const room = await this.rooms.findById(workflow.battleId)
        if (room !== null) roomsById.set(room.id, room)
      }
      for (const room of roomsById.values()) {
        try {
          await this.reconcileRoom(room)
        } catch (error: unknown) {
          this.logger.error('battle_drop_reconciliacion_fallo', {
            roomId: room.id,
            reason: error instanceof Error ? error.name : 'desconocido',
          })
        }
      }
      await this.deliverNotifications()
    } catch (error: unknown) {
      this.logger.error('battle_drop_barrido_fallo', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })
    } finally {
      this.running = false
    }
  }

  private async deliverNotifications(): Promise<void> {
    const due = await this.workflows.findUnnotified(50)
    for (const workflow of due) {
      if (workflow.receipt === null) continue
      for (const role of ['winner', 'loser'] as const) {
        if (role === 'winner' ? workflow.winnerNotified : workflow.loserNotified) continue
        try {
          await this.notifications.notify({
            receipt: workflow.receipt,
            recipientId: role === 'winner' ? workflow.killerPlayerId : workflow.defeatedPlayerId,
            role: role === 'winner' ? 'GAINED' : 'LOST',
          })
          await this.workflows.markNotified(workflow.id, role)
        } catch (error: unknown) {
          this.logger.error('battle_drop_notificacion_fallo', {
            workflowId: workflow.id,
            role,
            reason: error instanceof Error ? error.name : 'desconocido',
          })
        }
      }
    }
  }

  private async reconcileRoom(room: BattleRoom): Promise<void> {
    // HU-30/HU-93.3: el drop de Versus solo existe en PVP (`PersistVersusDropDecision`
    // ya lo limita asi). Una sala PVE nunca tiene decisiones de drop que conciliar,
    // asi que barrerla igual solo produce una llamada a `closeBattle` contra
    // Player-Inventory que nunca abrio nada para esa batalla.
    if (room.mode !== BattleMode.Pvp) return
    const decisions = battleDropEvents(room)
    for (const { seq, decision } of decisions) {
      await this.workflows.createIfAbsent({
        battleId: room.id,
        defeatEventSeq: seq,
        killerPlayerId: decision.killerPlayerId,
        defeatedPlayerId: decision.defeatedPlayerId,
        resolution: decision.resolution,
      })
    }
    if (room.status !== BattleRoomStatus.Finished) return

    let allCredited = true
    for (const { seq } of decisions) {
      const id = battleDropWorkflowId(room.id, seq)
      let workflow = await this.workflows.findById(id)
      if (workflow === null) {
        allCredited = false
        continue
      }
      if (workflow.state === 'PENDING' || workflow.state === 'FAILED_RETRYABLE') {
        if (workflow.resolution.status !== 'PENDING') {
          throw new Error('Workflow de drop inconsistente.')
        }
        try {
          const receipt = await this.inventory.transfer({
            battleId: workflow.battleId,
            defeatEventSeq: workflow.defeatEventSeq,
            sourcePlayerId: workflow.defeatedPlayerId,
            targetPlayerId: workflow.killerPlayerId,
            productInstanceId: workflow.resolution.selected.productInstanceId,
          })
          await this.workflows.markCredited(id, receipt)
          workflow = await this.workflows.findById(id)
        } catch (error: unknown) {
          await this.workflows.markFailed(id)
          this.logger.error('battle_drop_transferencia_fallo', {
            workflowId: id,
            reason: error instanceof Error ? error.name : 'desconocido',
          })
        }
      }
      if (workflow?.resolution.status === 'PENDING' && workflow.state !== 'CREDITED') {
        allCredited = false
      }
    }

    if (!allCredited || (await this.workflows.isBattleClosed(room.id))) return
    await this.inventory.closeBattle(room.id)
    const playerIds = [
      ...new Set(
        room.battle?.turnOrder.flatMap((entry) =>
          entry.playerId === null ? [] : [entry.playerId],
        ) ?? [],
      ),
    ]
    for (const playerId of playerIds) await this.commitments.release(room.id, playerId)
    await this.workflows.markBattleClosed(room.id)
  }
}
