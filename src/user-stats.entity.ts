import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity()
export class UserStats {
  @PrimaryColumn({ type: 'bigint' })
  userId!: string;

  @Column({ default: 0 })
  downloadsToday!: number;

  @Column()
  lastResetDate!: string;

  @Column({ nullable: true, type: 'int' })
  customLimit!: number | null;

  @Column({ nullable: true, type: 'timestamptz' })
  customLimitExpires!: Date | null;

  @Column({ nullable: true, type: 'boolean' })
  customProtectContent!: boolean | null;

  @Column({ nullable: true, type: 'timestamptz' })
  customProtectContentExpires!: Date | null;

  @Column({ nullable: true, type: 'int' })
  lastRandomMessageId!: number | null;
}
