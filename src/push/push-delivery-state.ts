import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"

export interface PushDeliverySnapshot {
  date: string
  count: number
}

export class PushDeliveryState {
  constructor(private readonly statePath: string) {}

  async read(): Promise<PushDeliverySnapshot> {
    const today = new Date().toISOString().slice(0, 10)
    if (!existsSync(this.statePath)) {
      return { date: today, count: 0 }
    }
    try {
      const snapshot = JSON.parse(await fs.readFile(this.statePath, "utf-8")) as PushDeliverySnapshot
      if (snapshot.date !== today) {
        return { date: today, count: 0 }
      }
      return snapshot
    } catch {
      return { date: today, count: 0 }
    }
  }

  async increment(): Promise<PushDeliverySnapshot> {
    const snapshot = await this.read()
    const next = { date: snapshot.date, count: snapshot.count + 1 }
    await this.write(next)
    return next
  }

  async write(snapshot: PushDeliverySnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true })
    await fs.writeFile(this.statePath, JSON.stringify(snapshot, null, 2), "utf-8")
  }
}
