import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity()
export class BotSettings {
  @PrimaryColumn()
  id!: number;

  @Column({ default: false })
  forceJoinActive!: boolean;

  @Column("text", { array: true, default: [] })
  forceJoinChannels!: string[];

  @Column({ nullable: true, type: 'text' })
  targetChannelId!: string | null;

  @Column({ default: 0 })
  targetChannelMaxId!: number;
}
