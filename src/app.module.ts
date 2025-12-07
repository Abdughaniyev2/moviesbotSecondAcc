import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotService } from './bot.service';
import { Movie } from './movies/movie.entity';
import { MoviesService } from './movies/movies.service';
import { Watchlist } from './watchlist/watchlist.entity';
import { WatchlistService } from './watchlist/watchlist.service';
import * as dotenv from 'dotenv';
import { UserModule } from './users/user.module';
dotenv.config()

@Module({

    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot({
            type: 'postgres',
            url: process.env.DATABASE_URL, // FOR RAILWAY
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT || 5432),
            username: String(process.env.DB_USER),
            password: String(process.env.DB_PASS),
            database: process.env.DB_NAME,
            autoLoadEntities: true,
            synchronize: true,
        }),
        UserModule,

        TypeOrmModule.forFeature([Movie, Watchlist]),

    ],
    providers: [BotService, MoviesService, WatchlistService],

})

export class AppModule { }

