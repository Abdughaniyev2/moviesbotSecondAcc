// src/users/user.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity()
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ unique: true })
  telegramId!: string;

  @Column({ nullable: true })
  username?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  lastSeen!: Date;

  @Column({ default: 0 })
  dailyDownloadCount!: number;

  @Column({ nullable: true, type: "varchar", length: 10 })
  lastDownloadDate?: string; // Store as YYYY-MM-DD string
}
