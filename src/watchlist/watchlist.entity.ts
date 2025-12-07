import { Entity, PrimaryGeneratedColumn, Column, Unique, Index } from 'typeorm';

@Entity('watchlists')
@Unique(['userId', 'movieCode'])
export class Watchlist {
    @PrimaryGeneratedColumn()
    id!: number;

    @Index()
    @Column()
    userId!: string; // Telegram user id as string

    @Index()
    @Column()
    movieCode!: string; // Movie.code (string)
}

