// src/users/user.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "./user.entity";

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private repo: Repository<User>
  ) {}

  async saveIfNotExists(telegramId: string, username?: string) {
    let user = await this.repo.findOne({ where: { telegramId } });
    if (!user) {
      user = this.repo.create({
        telegramId,
        username,
        dailyDownloadCount: 0,
        lastDownloadDate: undefined,
      });
      return this.repo.save(user); // only save new user
    }
    return user; // just return existing user
  }

  async remove(telegramId: string) {
    return this.repo.delete({ telegramId });
  }

  async countUsers(): Promise<number> {
    return this.repo.count();
  }

  async findAll(): Promise<User[]> {
    return this.repo.find({ order: { createdAt: "DESC" } });
  }

  async getUsersPaginated(page = 1, limit = 10) {
    const [users, total] = await this.repo.findAndCount({
      order: { createdAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });

    const totalPages = Math.ceil(total / limit);
    return { users, totalPages };
  }

  private getTodayDateString(): string {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  async checkAndIncrementDownload(
    telegramId: string,
    dailyLimit: number = 10
  ): Promise<{ canDownload: boolean; remaining: number; newCount: number }> {
    // Get or create user - always get fresh from database
    let user = await this.repo.findOne({ where: { telegramId } });

    if (!user) {
      user = this.repo.create({
        telegramId,
        dailyDownloadCount: 0,
        lastDownloadDate: undefined,
      });
      user = await this.repo.save(user);
      // Reload to get the saved user
      user = await this.repo.findOne({ where: { telegramId } });
      if (!user) {
        throw new Error("Failed to create user");
      }
    }

    const todayStr = this.getTodayDateString();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Initialize count if null/undefined
    if (
      user.dailyDownloadCount === undefined ||
      user.dailyDownloadCount === null
    ) {
      user.dailyDownloadCount = 0;
    }

    // Get last download date (already stored as string YYYY-MM-DD)
    const lastDownloadStr = user.lastDownloadDate || null;

    // Reset count if it's a different day
    if (lastDownloadStr && lastDownloadStr !== todayStr) {
      console.log(
        `[DEBUG] Different day detected, resetting count. Old date: ${lastDownloadStr}, Today: ${todayStr}`
      );
      user.dailyDownloadCount = 0;
      user.lastDownloadDate = todayStr; // Store as string
      user = await this.repo.save(user);
      // Reload to get fresh data
      const reloaded = await this.repo.findOne({ where: { telegramId } });
      if (reloaded) {
        user = reloaded;
      }
    } else if (!lastDownloadStr) {
      // First download ever - set date
      user.lastDownloadDate = todayStr; // Store as string
      user = await this.repo.save(user);
      // Reload to get fresh data
      const reloaded = await this.repo.findOne({ where: { telegramId } });
      if (reloaded) {
        user = reloaded;
      }
    }

    // Get current count BEFORE incrementing (use fresh data)
    const currentCount = user.dailyDownloadCount || 0;

    // Check if can download
    const canDownload = currentCount < dailyLimit;

    if (canDownload) {
      // Increment the count
      user.dailyDownloadCount = currentCount + 1;
      user = await this.repo.save(user);

      // Reload to verify the save
      const reloadedUser = await this.repo.findOne({ where: { telegramId } });
      if (reloadedUser) {
        user = reloadedUser;
      }
    }

    const finalCount = user.dailyDownloadCount || 0;
    const remaining = canDownload ? dailyLimit - finalCount : 0;

    console.log(
      `[DEBUG] User ${telegramId}: BEFORE=${currentCount}, AFTER=${finalCount}, limit=${dailyLimit}, canDownload=${canDownload}, date=${
        lastDownloadStr || "null"
      }`
    );

    return {
      canDownload,
      remaining,
      newCount: finalCount,
    };
  }
}
