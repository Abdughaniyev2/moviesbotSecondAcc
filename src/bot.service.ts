import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Telegraf } from "telegraf";
import { MoviesService } from "./movies/movies.service";
import { WatchlistService } from "./watchlist/watchlist.service";
import { UserService } from "./users/user.service";
import * as dotenv from "dotenv";

dotenv.config();

type ParsedCaption = {
  code: string;
  title: string;
  category?: string;
  description?: string;
  descriptionStartOffset?: number;
};

const owner = Number(process.env.ADMIN);
const ADMINS: number[] = [owner];

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot!: Telegraf;
  private knownUsers = new Set<string>();

  private forceJoinActive = false;
  private forceJoinChannels: string[] = [];

  private targetChannelId: string | null = null;
  private targetChannelMaxId: number = 0;

  private dailyLimit = 3;
  private userDownloads = new Map<
    number,
    {
      downloadsToday: number;
      lastResetDate: string;
      customLimit?: number;
      customLimitExpires?: Date;
      customProtectContent?: boolean;
      customProtectContentExpires?: Date;
      lastRandomMessageId?: number;
      processingRandom?: boolean;
    }
  >();

  constructor(
    private readonly moviesService: MoviesService,
    private readonly watchlistService: WatchlistService,
    private readonly userService: UserService
  ) {
    const token = process.env.BOT_TOKEN;
    if (!token) throw new Error("BOT_TOKEN is missing");
    this.bot = new Telegraf(token);
  }

  async onModuleInit() {
    if (!this.bot) return;

    await this.cacheUsers();
    this.registerHandlers();

    const launch = async () => {
      try {
        await this.bot.launch();
        console.log("🤖 Telegram bot started");
      } catch (err) {
        console.error("❌ Bot failed to start:", (err as Error).message);
        console.log("⏳ Retrying in 5 seconds...");
        setTimeout(launch, 5000);
      }
    };

    launch();
  }

  async onModuleDestroy() {
    if (this.bot) {
      // don't await .stop() — some Telegraf versions don't return a Promise here
      this.bot.stop();
      console.log("🛑 Telegram bot stopped");
    }
  }

  private registerHandlers() {
    // ===== Channel posts =====
    this.bot.on("channel_post", async (ctx) => {
      try {
        const post = ctx.channelPost as any;

        // Determine file type and file ID
        let fileId: string | undefined;
        let fileType: "video" | "photo" | "document" | undefined;

        if (post.video) {
          fileId = post.video.file_id;
          fileType = "video";
        } else if (post.photo?.length) {
          // Get highest resolution photo
          fileId = post.photo[post.photo.length - 1].file_id;
          fileType = "photo";
        } else if (post.document) {
          fileId = post.document.file_id;
          fileType = "document";
        } else {
          return; // No valid file
        }

        const caption: string = post.caption || "";
        if (!caption) return;

        const parsed = this.parseCaption(caption);
        if (!parsed) {
          await this.notifyOwner("⚠️ Caption format is incorrect");
          return;
        }

        // If description exists, convert it to HTML to preserve formatting (quotes, bold, etc.)
        if (
          parsed.description &&
          parsed.descriptionStartOffset !== undefined &&
          post.caption_entities
        ) {
          const start = parsed.descriptionStartOffset;
          const descText = caption.substring(start);
          // Filter entities that belong to the description and adjust their offset
          const descEntities = post.caption_entities
            .filter((e: any) => e.offset >= start)
            .map((e: any) => ({ ...e, offset: e.offset - start }));
          parsed.description = this.toHtml(descText, descEntities);
        }

        const exists = await this.moviesService.findByCode(parsed.code);
        if (exists) {
          await this.notifyOwner(
            `⚠️ Code ${parsed.code} already exists. Movie not saved.`
          );
          return;
        }

        await this.moviesService.createStrict({
          code: parsed.code,
          title: parsed.title,
          category: parsed.category,
          description: parsed.description,
          fileId,
          fileType,
        });

        await this.notifyOwner(`✅ Saved #${parsed.code} — ${parsed.title}`);
      } catch (err: any) {
        console.error("channel_post error:", err);
        await this.notifyOwner(`❌ Error: ${err?.message || "unknown"}`);
      }
    });

    // ===== Broadcast =====
    this.bot.command("broadcast", async (ctx) => {
      if (!ctx.from || !ADMINS.includes(ctx.from.id)) {
        return ctx.reply("❌ You do not have permission");
      }

      const args = ctx.message.text.split(" ").slice(1);
      if (!args.length) {
        return ctx.reply(
          "⚠️ Usage:\n" +
            "/broadcast <text>\n" +
            "/broadcast <code>\n" +
            "/broadcast <code> <custom caption>"
        );
      }

      const firstArg = args[0];

      // if first argument is a number → movie code
      if (/^\d+$/.test(firstArg)) {
        const code = firstArg;
        const movie = await this.moviesService.findByCode(code);

        if (!movie || movie.isDeleted) {
          return ctx.reply(`❌ Movie ${code} not found or deleted`);
        }

        // caption → join remaining arguments
        const caption =
          args.slice(1).join(" ") ||
          `🎬 ${this.escapeHtml(movie.title)}\n🏷 ${this.escapeHtml(
            movie.category ?? "Unknown"
          )}\n\n${movie.description ?? ""}`;

        ctx.reply(`📢 Sending movie #${code}...`);

        await this.broadcast(
          [{ fileId: movie.fileId, fileType: movie.fileType, text: caption }],
          "HTML"
        );

        return ctx.reply(`✅ Movie #${code} sent!`);
      }

      // plain text broadcast
      const message = args.join(" ");
      await this.broadcast([{ text: message }], "HTML");
      return ctx.reply("✅ Done!");
    });

    // ===== Movie by code =====
    this.bot.hears(/^\d+$/, async (ctx) => {
      if (!(await this.forceJoinCheck(ctx))) return;

      const code = ctx.message.text.trim();
      const movie = await this.moviesService.findByCode(code);

      if (!movie || movie.isDeleted)
        return ctx.reply("❌ Movie not found or deleted");

      // Check if user is admin - skip download limit for admins
      const isAdmin = ctx.from?.id && ADMINS.includes(ctx.from.id);

      // Check daily download limit (only for non-admins)
      if (!isAdmin) {
        const userId = ctx.from.id;
        const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

        let stats = this.userDownloads.get(userId);
        if (!stats || stats.lastResetDate !== today) {
          const customLimit = stats?.customLimit;
          const customLimitExpires = stats?.customLimitExpires;
          const customProtectContent = stats?.customProtectContent;
          const customProtectContentExpires = stats?.customProtectContentExpires;
          stats = {
            downloadsToday: 0,
            lastResetDate: today,
            customLimit,
            customLimitExpires,
            customProtectContent,
            customProtectContentExpires,
          };
          this.userDownloads.set(userId, stats);
        }

        let currentLimit = this.dailyLimit;
        if (
          stats.customLimit &&
          stats.customLimitExpires &&
          stats.customLimitExpires > new Date()
        ) {
          currentLimit = stats.customLimit;
        } else if (stats.customLimit) {
          // Clean up expired custom limit
          delete stats.customLimit;
          delete stats.customLimitExpires;
        }

        if (stats.downloadsToday >= currentLimit) {
          return ctx.reply(
            `<b>Daily limit reached! 🚩</b> \nYour limit  is  ${currentLimit} movies per day.\nPlease try again tomorrow...✅\n\n<b>Want more access?</b> \nExtend your limit to  7  movies/day \nand enable Download mode by contacting the admin via /help.\n\n<blockquote>Higher Daily Limit (7 days) - $1.50.</blockquote>\n<blockquote>Download Access (7 days) - $1.50.</blockquote>`,
            { parse_mode: "HTML" }
          );
        }
       

        stats.downloadsToday++;
        await this.userService.saveIfNotExists(userId.toString(), ctx.from.username);
      }

      // Determine protect_content setting
      let protectContent = true; // Default: protected

      if (isAdmin) {
        protectContent = false;
      } else {
        const userId = ctx.from.id;
        const stats = this.userDownloads.get(userId);
        if (stats?.customProtectContent === false) {
          if (stats.customProtectContentExpires && stats.customProtectContentExpires > new Date()) {
            protectContent = false;
          } else if (stats) {
            delete stats.customProtectContent;
            delete stats.customProtectContentExpires;
          }
        }
      }

      try {
        const caption = `🎬 ${this.escapeHtml(
          movie.title
        )}\n🏷 ${this.escapeHtml(movie.category ?? "Unknown")}\n\n${
          movie.description ?? ""
        }`;

        // Send movie with protect_content to prevent forwarding
        switch (movie.fileType) {
          case "photo":
            await ctx.replyWithPhoto(movie.fileId, {
              caption,
              protect_content: protectContent,
              parse_mode: "HTML",
            });
            break;
          case "video":
            await ctx.replyWithVideo(movie.fileId, {
              caption,
              protect_content: protectContent,
              parse_mode: "HTML",
            });
            break;
          case "document":
          default:
            await ctx.replyWithDocument(movie.fileId, {
              caption,
              protect_content: protectContent,
              parse_mode: "HTML",
            });
            break;
        }
      } catch (err: any) {
        console.error(`❌ Failed to send movie ${code}:`, err.message);
        return ctx.reply("⚠️ Error sending movie file");
      }
    });

    // ===== Watchlist =====
    this.bot.command("save", async (ctx) => {
      if (!(await this.forceJoinCheck(ctx))) return;

      const [_, code] = ctx.message.text.split(/\s+/);
      if (!code) return ctx.reply("⚠️ Usage: /save <code>");

      try {
        const movie = await this.moviesService.findByCode(code);
        if (!movie || movie.isDeleted)
          return ctx.reply("❌ Movie not found or deleted");

        const msg = await this.watchlistService.addToWatchlist(
          String(ctx.from.id),
          code
        );
        return ctx.reply(msg);
      } catch (e: any) {
        return ctx.reply(`❌ ${e?.message || "Error saving"}`);
      }
    });

    this.bot.command("watchlist", async (ctx) => {
      if (!(await this.forceJoinCheck(ctx))) return;
      const msg = await this.watchlistService.getWatchlist(String(ctx.from.id));
      return ctx.reply(msg);
    });

    this.bot.command("remove", async (ctx) => {
      if (!(await this.forceJoinCheck(ctx))) return;

      const [_, code] = ctx.message.text.split(/\s+/);
      if (!code) return ctx.reply("⚠️ Usage: /remove <code>");

      const msg = await this.watchlistService.removeFromWatchlist(
        String(ctx.from.id),
        code
      );
      return ctx.reply(msg);
    });

    // helper: normalize channel names
    function normalizeChannel(input: string): string | null {
      if (!input) return null;

      let clean = input.trim().replace(/[,]+$/, ""); // remove spaces/commas

      if (!clean) return null;

      if (clean.startsWith("https://t.me/")) {
        clean = "@" + clean.replace("https://t.me/", "").replace("/", "");
      }

      if (!clean.startsWith("@")) {
        clean = "@" + clean;
      }

      return clean;
    }

    // ===== Force-join =====
    this.bot.command("forceon", async (ctx) => {
      if (!ctx.from || !ADMINS.includes(ctx.from.id))
        return ctx.reply("❌ You do not have permission");

      const args = ctx.message.text
        .split(" ")
        .slice(1)
        .map(normalizeChannel)
        .filter((ch): ch is string => ch !== null);

      if (!args.length)
        return ctx.reply("⚠️ Usage: /forceon @channel1 @channel2 ...");

      let added: string[] = [];
      for (const ch of args) {
        if (!this.forceJoinChannels.includes(ch)) {
          this.forceJoinChannels.push(ch);
          added.push(ch);
        }
      }

      if (this.forceJoinChannels.length > 0) this.forceJoinActive = true;

      if (added.length) {
        ctx.reply(
          `✅ Force-join channels added: ${added.join(",\n")}\n\n` +
            `📌 Current list: \n${this.forceJoinChannels.join(",\n")}`
        );
      } else {
        ctx.reply("⚠️ No new channels added, all are already in the list.");
      }
    });

    this.bot.command("forceoff", async (ctx) => {
      if (!ctx.from || !ADMINS.includes(ctx.from.id))
        return ctx.reply("❌ You do not have permission");

      const args = ctx.message.text
        .split(" ")
        .slice(1)
        .map(normalizeChannel)
        .filter((ch): ch is string => ch !== null);

      // if no args → disable everything
      if (!args.length) {
        this.forceJoinChannels = [];
        this.forceJoinActive = false;
        return ctx.reply("✅ Force-join completely disabled.");
      }

      let removed: string[] = [];
      let notFound: string[] = [];

      for (const ch of args) {
        if (this.forceJoinChannels.includes(ch)) {
          this.forceJoinChannels = this.forceJoinChannels.filter(
            (c) => c !== ch
          );
          removed.push(ch);
        } else {
          notFound.push(ch);
        }
      }

      if (this.forceJoinChannels.length === 0) {
        this.forceJoinActive = false;
      }

      let reply = "";
      if (removed.length) reply += `🗑️ Removed: ${removed.join(", ")}\n`;
      if (notFound.length)
        reply += `⚠️ Not found (not previously added): ${notFound.join(
          ", "
        )}\n`;
      if (this.forceJoinChannels.length)
        reply += `📌 Remaining channels: ${this.forceJoinChannels.join(", ")}`;
      else reply += `⚠️ No channels are currently mandatory.`;

      ctx.reply(reply);
    });

    // ===== Enable/Disable movies =====
    this.bot.command("disable", async (ctx) => {
      if (!ctx.from || !ADMINS.includes(ctx.from.id)) {
        return ctx.reply("❌ You do not have permission");
      }

      const [_, code] = ctx.message.text.split(/\s+/);
      if (!code) return ctx.reply("⚠️ Usage: /disable <code>");

      try {
        const movie = await this.moviesService.findByCode(code);
        if (!movie) {
          return ctx.reply(`❌ Movie ${code} not found`);
        }

        movie.isDeleted = true;
        await this.moviesService.update(movie);

        return ctx.reply(`🚫 Movie #${code} disabled`);
      } catch (err: any) {
        console.error("disable error:", err);
        return ctx.reply(`⚠️ Error: ${err?.message || "unknown error"}`);
      }
    });

    this.bot.command("enable", async (ctx) => {
      if (!ctx.from || !ADMINS.includes(ctx.from.id)) {
        return ctx.reply("❌ You do not have permission");
      }

      const parts = ctx.message.text.trim().split(/\s+/);
      const raw = parts[1];
      if (!raw) return ctx.reply("⚠️ Usage: /enable <code>");

      const code = raw.replace(/^#/, "").trim();

      try {
        await this.moviesService.setDeleted(code, false);
        return ctx.reply(`✅ Movie #${code} enabled`);
      } catch (err: any) {
        console.error("enable error:", err);
        return ctx.reply(`⚠️ Error: ${err?.message || "unknown error"}`);
      }
    });

    // ===== Daily Limit =====
    this.bot.command("limit", async (ctx) => {
      if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

      const args = ctx.message.text.split(/\s+/);
      if (args.length < 2) {
        return ctx.reply(`📊 Current daily limit: ${this.dailyLimit}`);
      }

      const newLimit = parseInt(args[1], 10);
      if (isNaN(newLimit) || newLimit < 0) {
        return ctx.reply("⚠️ Please enter a valid number.");
      }

      this.dailyLimit = newLimit;
      return ctx.reply(`✅ Daily limit set to ${this.dailyLimit} movies/day.`);
    });

    this.bot.command("limitup", async (ctx) => {
      if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

      const args = ctx.message.text.split(/\s+/);
      if (args.length < 4) {
        return ctx.reply("⚠️ Usage: /limitup <userId> <limit> <days>");
      }

      const targetId = parseInt(args[1], 10);
      const newLimit = parseInt(args[2], 10);
      const days = parseInt(args[3], 10);

      if (isNaN(targetId) || isNaN(newLimit) || newLimit < 0 || isNaN(days) || days <= 0) {
        return ctx.reply("⚠️ Invalid arguments. Ensure User ID, limit, and days are numbers.");
      }

      const userId = targetId;
      const today = new Date().toISOString().split("T")[0];

      const stats = this.userDownloads.get(userId) || {
        downloadsToday: 0,
        lastResetDate: today,
      };

      const expires = new Date();
      expires.setDate(expires.getDate() + days);

      stats.customLimit = newLimit;
      stats.customLimitExpires = expires;
      this.userDownloads.set(userId, stats);

      return ctx.reply(`✅ Limit for ID <code>${userId}</code> has been set to ${newLimit} for ${days} day(s).\n<blockquote>Expires on: ${expires.toLocaleString()}</blockquote>`,{ parse_mode: "HTML" });
      
    });

    this.bot.command("protecton", async (ctx) => {
      if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

      const args = ctx.message.text.split(/\s+/);
      if (args.length < 2) {
        return ctx.reply("⚠️ Usage: /protecton <userId>");
      }

      const userId = parseInt(args[1], 10);

      if (isNaN(userId)) {
        return ctx.reply("⚠️ Invalid User ID.");
      }

      const stats = this.userDownloads.get(userId);
      if (stats) {
        delete stats.customProtectContent;
        delete stats.customProtectContentExpires;
      }

      return ctx.reply(
        `✅ Protection ENABLED (Default) for ID ${userId}.`
      );
    });

    this.bot.command("protectoff", async (ctx) => {
      if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

      const args = ctx.message.text.split(/\s+/);
      if (args.length < 3) {
        return ctx.reply("⚠️ Usage: /protectoff <userId> <days>");
      }

      const userId = parseInt(args[1], 10);
      const days = parseInt(args[2], 10);

      if (isNaN(userId) || isNaN(days) || days <= 0) {
        return ctx.reply("⚠️ Invalid User ID or days.");
      }

      const today = new Date().toISOString().split("T")[0];
      let stats = this.userDownloads.get(userId);
      if (!stats) {
        stats = { downloadsToday: 0, lastResetDate: today };
        this.userDownloads.set(userId, stats);
      }

      const expires = new Date();
      expires.setDate(expires.getDate() + days);

      stats.customProtectContent = false;
      stats.customProtectContentExpires = expires;

      return ctx.reply(
        `✅ Protection DISABLED (VIP) for ID ${userId} for ${days} day(s).`
      );
    });

    // ===== Stats with pagination =====
    this.bot.command("stats", async (ctx) => {
      const userId = ctx.from?.id;
      const totalUsers = await this.userService.countUsers();

      if (!userId || !ADMINS.includes(userId)) {
        return ctx.reply(`👥 Total bot users: ${totalUsers}`);
      }

      const users = await this.userService.findAll();
      if (!users.length) {
        return ctx.reply("⚠️ No users yet");
      }

      const pageSize = 10;
      const page = 1;
      const totalPages = Math.ceil(users.length / pageSize);

      const slice = users.slice(0, pageSize);
      const text = slice
        .map((u, i) => `${i + 1}. @${u.username ?? u.telegramId}`)
        .join("\n");

      await ctx.reply(
        `📊 Total users: ${users.length} (Page ${page}/${totalPages})\n\n${text}`,
        {
          reply_markup: {
            inline_keyboard:
              totalPages > 1
                ? [
                    [
                      {
                        text: "➡️ Next",
                        callback_data: `stats_page_${page + 1}`,
                      },
                    ],
                  ]
                : [],
          },
        }
      );
    });

    this.bot.action(/stats_page_(\d+)/, async (ctx) => {
      if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;

      const page = Number(ctx.match[1]);
      const users = await this.userService.findAll();
      const pageSize = 10;
      const totalPages = Math.ceil(users.length / pageSize);

      const start = (page - 1) * pageSize;
      const slice = users.slice(start, start + pageSize);

      const text = slice
        .map((u, i) => `${start + i + 1}. @${u.username ?? u.telegramId}`)
        .join("\n");

      const buttons: any[] = [];
      if (page > 1)
        buttons.push({
          text: "⬅️ Prev",
          callback_data: `stats_page_${page - 1}`,
        });
      if (page < totalPages)
        buttons.push({
          text: "➡️ Next",
          callback_data: `stats_page_${page + 1}`,
        });

      await ctx.editMessageText(
        `📊 Total users: ${users.length} (Page ${page}/${totalPages})\n\n${text}`,
        {
          reply_markup: { inline_keyboard: [buttons] },
        }
      );

      // call answerCbQuery without awaiting (keeps compatibility)
      ctx.answerCbQuery();
    });

    // ===== Channel Info =====
    this.bot.command("channelinfo", async (ctx) => {
      if (!ctx.from || !ADMINS.includes(ctx.from.id)) return;
      const args = ctx.message.text.split(/\s+/);
      if (args.length < 2) {
        return ctx.reply("⚠️ Usage: /channelinfo <channel_id> [max_id]");
      }

      this.targetChannelId = args[1];
      
      // If max_id is provided manually
      if (args[2]) {
        const maxId = parseInt(args[2], 10);
        if (!isNaN(maxId)) {
          this.targetChannelMaxId = maxId;
          return ctx.reply(
            `✅ Target channel set to: ${this.targetChannelId}\nMax ID set to: ${this.targetChannelMaxId}`
          );
        }
      }

      // Auto-detect max ID
      const statusMsg = await ctx.reply("🔄 Auto-detecting max ID... Please wait.");
      let maxId = 0;

      try {
        // Strategy 1: Try to send a message (if admin)
        try {
          const testMsg = await ctx.telegram.sendMessage(this.targetChannelId, "🔍 Calibrating...", { disable_notification: true });
          maxId = testMsg.message_id;
          await ctx.telegram.deleteMessage(this.targetChannelId, maxId).catch(() => {});
        } catch (e) {
          // Strategy 2: Probing (Read-only / Guest)
          const checkId = async (id: number) => {
            try {
              const msg = await ctx.telegram.copyMessage(ctx.chat.id, this.targetChannelId!, id, { disable_notification: true });
              await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
              return true;
            } catch {
              return false;
            }
          };

          let current = 100;
          let lastValid = 0;

          // Exponential search
          while (true) {
            if (await checkId(current)) {
              lastValid = current;
              current *= 2;
              if (current > 1000000) break; 
            } else {
              break;
            }
          }

          // Binary search refinement
          let low = lastValid;
          let high = current;
          
          for (let i = 0; i < 5; i++) {
             const mid = Math.floor((low + high) / 2);
             if (mid <= low) break;
             if (await checkId(mid)) {
               low = mid;
             } else {
               high = mid;
             }
          }
          maxId = high;
        }

        this.targetChannelMaxId = maxId;
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          undefined,
          `✅ Target channel set to: ${this.targetChannelId}\nMax ID auto-detected: ${this.targetChannelMaxId}`
        );
      } catch (err: any) {
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          undefined,
          `⚠️ Auto-detection failed. Please provide max_id manually.\nError: ${err.message}`
        );
      }
    });

    // ===== Random Info Button (Persistent) =====
    this.bot.hears("🎲 Random Info", async (ctx) => {
      ctx.deleteMessage().catch(() => {}); // Try to delete user trigger message

      if (!this.targetChannelId || !this.targetChannelMaxId) {
        const msg = await ctx.reply("⚠️ Random movie source not configured. Use /channelinfo first.");
        setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 3000);
        return;
      }

      const userId = ctx.from.id;
      let stats = this.userDownloads.get(userId);
      if (!stats) {
        stats = {
          downloadsToday: 0,
          lastResetDate: new Date().toISOString().split("T")[0],
        };
        this.userDownloads.set(userId, stats);
      }

      if (stats.processingRandom) return;
      stats.processingRandom = true;

      try {
        // Delete previous message if exists
        if (stats.lastRandomMessageId) {
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, stats.lastRandomMessageId);
          } catch (err) {
            // Ignore error (message might be too old or already deleted)
          }
          stats.lastRandomMessageId = undefined;
        }

        // Try to fetch a random post (retry a few times if empty/deleted)
        let sentMessageId: number | null = null;
        for (let i = 0; i < 5; i++) {
          const randomId = Math.floor(Math.random() * this.targetChannelMaxId) + 1;
          try {
            const msg = await ctx.telegram.copyMessage(ctx.chat.id, this.targetChannelId, randomId);
            sentMessageId = msg.message_id;
            break; // Success
          } catch (err) {
            // Continue retrying
          }
        }

        if (sentMessageId) {
          stats.lastRandomMessageId = sentMessageId;
        } else {
          const msg = await ctx.reply("⚠️ Failed to find a valid movie. Please try again.");
          setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 3000);
        }
      } finally {
        stats.processingRandom = false;
      }
    });

    // ===== Help =====
    this.bot.command("help", async (ctx) => {
      return ctx.reply(
        "You can watch any movie you want through this bot. \n" +
          "Enter the movie code and watch! \n" +
          "Code example: 915 \n\n" +
          "Hold on commands, \nafter the command appears on screen, you can enter the movie code and use it for saving, deleting or other operations. \n" +
          "📬 If you have questions or issues, contact the admin 👇",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📩 Contact Admin",
                  url: "https://t.me/OnLastBreath",
                },
              ],
            ],
          },
        }
      );
    });

    // ===== Track new users =====
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id) {
        const id = ctx.from.id.toString();
        await this.userService.saveIfNotExists(id, ctx.from.username);
        this.knownUsers.add(id);
      }
      return next();
    });

    // ===== Start command =====
    this.bot.start(async (ctx) => {
      if (!(await this.forceJoinCheck(ctx))) return;

      const tgId = ctx.from.id.toString();
      const username = ctx.from.username || ctx.from.first_name;

      // ✅ safe save
      await this.userService.saveIfNotExists(tgId, username);

      await ctx.reply(
        // "👋 Welcome! Send a movie code or use the /help command."
        "👋 Welcome! Send a movie code or use the /help command.",
        {
          reply_markup: {
            keyboard: [[{ text: "🎲 Random Info" }]],
            resize_keyboard: true,
            is_persistent: true,
          },
        }
      );
    });
  }

  private async forceJoinCheck(ctx: any): Promise<boolean> {
    if (!this.forceJoinActive || !ctx.from) return true;

    const userId = ctx.from.id;
    let notJoined: string[] = [];

    for (const ch of this.forceJoinChannels) {
      try {
        const member = await this.bot.telegram.getChatMember(ch, userId);
        if (!["member", "administrator", "creator"].includes(member.status)) {
          notJoined.push(ch);
        }
      } catch {
        notJoined.push(ch);
      }
    }
    
    
    if (notJoined.length) {
      const channelsList = notJoined.map((ch, i) => `Channel ${i + 1}: ${ch}`).join("\n");
      await ctx.reply(
        `❌ You haven't joined the channels below:  \n\n${channelsList}\n\n` +
          `✅ Please join the channels and try again.`
      );
      return false;
    }

    return true;
  }

  private async sendToUser(user: { telegramId: string }, content: any) {
    try {
      if (content.type === "text") {
        await this.bot.telegram.sendMessage(user.telegramId, content.text, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        } as any);
      }

      if (content.type === "photo") {
        await this.bot.telegram.sendPhoto(
          user.telegramId,
          content.fileIdOrUrl,
          {
            caption: content.caption || "",
            parse_mode: "HTML",
          }
        );
      }

      if (content.type === "video") {
        await this.bot.telegram.sendVideo(
          user.telegramId,
          content.fileIdOrUrl,
          {
            caption: content.caption || "",
            parse_mode: "HTML",
            supports_streaming: true,
          }
        );
      }

      if (content.type === "document") {
        await this.bot.telegram.sendDocument(
          user.telegramId,
          content.fileIdOrUrl,
          {
            caption: content.caption || "",
            parse_mode: "HTML",
          }
        );
      }

      if (content.type === "animation") {
        await this.bot.telegram.sendAnimation(
          user.telegramId,
          content.fileIdOrUrl,
          {
            caption: content.caption || "",
            parse_mode: "HTML",
          }
        );
      }

      return true;
    } catch (err: any) {
      if (
        err?.response?.error_code === 403 ||
        err?.response?.error_code === 400
      ) {
        // User blocked bot or deactivated account
        await this.userService.remove(user.telegramId);
      }
      return false;
    }
  }

  private async broadcast(
    items: Array<{
      text?: string;
      fileId?: string;
      fileType?: "photo" | "video" | "document" | "animation";
    }>,
    parseMode: "HTML" | "MarkdownV2" | undefined = undefined
  ) {
    const users = await this.userService.findAll();
    console.log("📌 Number of users:", users.length);

    // split into chunks of 25 users (Telegram safe rate)
    const chunks = this.chunkArray(users, 25);

    for (const chunk of chunks) {
      await Promise.allSettled(
        chunk.map(async (user) => {
          if (!user.telegramId) return;

          for (const item of items) {
            const options: any = {};
            if (item.text) options.caption = item.text;
            if (parseMode) options.parse_mode = parseMode;

            try {
              switch (item.fileType) {
                case "photo":
                  await this.bot.telegram.sendPhoto(
                    user.telegramId,
                    item.fileId!,
                    options
                  );
                  break;
                case "video":
                  await this.bot.telegram.sendVideo(
                    user.telegramId,
                    item.fileId!,
                    options
                  );
                  break;
                case "document":
                  await this.bot.telegram.sendDocument(
                    user.telegramId,
                    item.fileId!,
                    options
                  );
                  break;
                case "animation":
                  await this.bot.telegram.sendAnimation(
                    user.telegramId,
                    item.fileId!,
                    options
                  );
                  break;
                default:
                  if (item.text) {
                    await this.bot.telegram.sendMessage(
                      user.telegramId,
                      item.text,
                      { parse_mode: parseMode }
                    );
                  }
                  break;
              }
            } catch (err: any) {
              const msg = err?.message || "unknown error";
              console.error(`❌ Failed to send to ${user.telegramId}: ${msg}`);

              if (
                msg.includes("Forbidden") ||
                msg.includes("user is deactivated")
              ) {
                try {
                  await this.userService.remove(user.telegramId);
                  console.log(`🗑️ ${user.telegramId} removed from database`);
                } catch (removeErr: any) {
                  console.error(
                    `❌ Error removing ${user.telegramId} from database:`,
                    removeErr.message
                  );
                }
              }
            }
          }
        })
      );

      // wait 1 second before next batch (to respect Telegram flood limits)
      await new Promise((res) => setTimeout(res, 1000));
    }
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private async notifyOwner(msg: string) {
    if (owner) {
      try {
        await this.bot.telegram.sendMessage(owner, msg);
      } catch (e) {
        console.error("❌ Failed to send message to owner:", e);
      }
    }
  }

  private async cacheUsers() {
    const users = await this.userService.findAll();
    users.forEach((u) => this.knownUsers.add(String(u.telegramId)));
    console.log(`📥 ${this.knownUsers.size} users cached`);
  }

  private escapeHtml(unsafe: string): string {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  private toHtml(text: string, entities: any[]): string {
    if (!entities || !entities.length) return this.escapeHtml(text);

    const points: { idx: number; val: string; type: "open" | "close"; order: number }[] = [];

    entities.forEach((e) => {
      let tag = "";
      switch (e.type) {
        case "bold": tag = "b"; break;
        case "italic": tag = "i"; break;
        case "underline": tag = "u"; break;
        case "strikethrough": tag = "s"; break;
        case "code": tag = "code"; break;
        case "pre": tag = "pre"; break;
        case "spoiler": tag = "tg-spoiler"; break;
        case "blockquote": tag = "blockquote"; break;
        case "text_link": tag = "a"; break;
      }
      if (!tag) return;

      const open = e.type === "text_link" ? `<a href="${e.url}">` : `<${tag}>`;
      const close = e.type === "text_link" ? "</a>" : `</${tag}>`;

      // Priority: Close tags before Open tags at same index
      // Within Open: Outer (longer) before Inner (shorter)
      // Within Close: Inner (shorter) before Outer (longer) - though usually same index means same scope end
      points.push({ idx: e.offset, val: open, type: "open", order: -e.length });
      points.push({ idx: e.offset + e.length, val: close, type: "close", order: e.length });
    });

    points.sort((a, b) => {
      if (a.idx !== b.idx) return a.idx - b.idx;
      // Close tags (type='close') should come before Open tags (type='open')
      if (a.type !== b.type) return a.type === "close" ? -1 : 1;
      return a.order - b.order;
    });

    let result = "";
    let cursor = 0;

    for (const p of points) {
      if (p.idx > cursor) {
        result += this.escapeHtml(text.substring(cursor, p.idx));
        cursor = p.idx;
      }
      result += p.val;
    }
    if (cursor < text.length) {
      result += this.escapeHtml(text.substring(cursor));
    }
    return result;
  }

  private parseCaption(caption: string): ParsedCaption | null {
    // Split into lines but preserve empty lines
    const allLines = caption.split("\n");
    if (!allLines.length) return null;

    // Trim only the first line for parsing code/title
    const firstLine = allLines[0].trim();
    const m = firstLine.match(/^\s*#?(\d+)\s*[-:–]*\s*(.+)$/);
    if (!m) return null;

    const code = m[1];
    const title = (m[2] || "").trim();
    if (!code || !title) return null;

    let category: string | undefined;
    let description: string | undefined;
    let descriptionStartIndex = -1;
    let currentOffset = 0;

    // Find Category and Description markers
    for (let i = 0; i < allLines.length; i++) {
      // Skip first line (title/code) for detection, but track offset
      if (i === 0) {
        currentOffset += allLines[i].length + 1; // +1 for \n
        continue;
      }

      const trimmedLine = allLines[i].trim();
      const cat = trimmedLine.match(/^Category:\s*(.+)$/i);
      if (cat) {
        category = cat[1].trim();
        currentOffset += allLines[i].length + 1;
        continue;
      }
      const desc = trimmedLine.match(/^Description:\s*(.+)$/i);
      if (desc) {
        // Found description start - preserve everything from here including empty lines and quotes
        descriptionStartIndex = i;
        // Get the original line to preserve quotes exactly as they are
        const originalLine = allLines[i];
        // Extract description part from original line (preserve quotes and formatting)
        const descMatch = originalLine.match(/^Description:\s*(.+)$/i);
        if (descMatch) {
          // Get the rest of the description from original lines (including empty lines and quotes)
          const descLines = [descMatch[1], ...allLines.slice(i + 1)];
          // Preserve original line breaks, empty lines, and quotes
          description = descLines.join("\n");

          // Calculate character offset where description content starts
          // currentOffset points to start of "Description: ..." line
          // We add the length of "Description: " prefix
          const prefixMatch = originalLine.match(/^Description:\s*/i);
          if (prefixMatch) {
            // Add offset of the prefix
            // Note: descriptionStartOffset is used to slice the original full caption
            // parsed.descriptionStartOffset = currentOffset + prefixMatch[0].length;
            // Actually, let's store the offset relative to the full caption
            // We need to be careful about \n chars. split('\n') consumes them.
            // currentOffset tracks them.
            
            // The logic below for descriptionStartOffset:
            // currentOffset is the index of the start of this line.
            // prefixMatch[0].length is the length of "Description: "
            // So content starts at currentOffset + prefixMatch[0].length
            
            // We return this so channel_post can slice the raw caption and entities
            return { 
              code, 
              title, 
              category, 
              description, 
              descriptionStartOffset: currentOffset + prefixMatch[0].length 
            };
          }
        }
        break;
      }
      currentOffset += allLines[i].length + 1;
    }

    return { code, title, category, description };
  }
}
