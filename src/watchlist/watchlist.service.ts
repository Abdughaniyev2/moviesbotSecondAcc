import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Watchlist } from "./watchlist.entity";
import { MoviesService } from "../movies/movies.service";

@Injectable()
export class WatchlistService {
    constructor(
        @InjectRepository(Watchlist)
        private readonly watchlistRepo: Repository<Watchlist>,
    private readonly moviesService: MoviesService
  ) {}

    async addToWatchlist(userId: string, movieCode: string): Promise<string> {
        const movie = await this.moviesService.findByCode(movieCode);
    if (!movie) throw new Error(`❌ Movie ${movieCode} not found`);

    const exists = await this.watchlistRepo.findOne({
      where: { userId, movieCode },
    });
    if (exists) return "✅ Movie is already in your watchlist";

    await this.watchlistRepo.save(
      this.watchlistRepo.create({ userId, movieCode })
    );
    return `🎬 ${movie.title} added to your watchlist`;
    }

    async getWatchlist(userId: string): Promise<string> {
        const items = await this.watchlistRepo.find({ where: { userId } });
    if (!items.length) return "📭 Your watchlist is empty";

    // Load movie information for each code
    const movies = await Promise.all(
      items.map((i) => this.moviesService.findByCode(i.movieCode))
    );
        const list = movies
            .filter((m): m is NonNullable<typeof m> => !!m)
      .map(
        (m) => `- ${m.code} ${m.title}${m.category ? ` (${m.category})` : ""}`
      )
      .join("\n");

    return `🎬 Your watchlist:\n${list}`;
  }

  async removeFromWatchlist(
    userId: string,
    movieCode: string
  ): Promise<string> {
    const row = await this.watchlistRepo.findOne({
      where: { userId, movieCode },
    });
    if (!row) return `⚠️ Movie ${movieCode} is not in your watchlist`;

        await this.watchlistRepo.remove(row);
    return `❌ Movie ${movieCode} removed from your watchlist`;
    }
}
