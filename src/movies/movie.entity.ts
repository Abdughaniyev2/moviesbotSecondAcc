import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class Movie {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ unique: true })
    code!: string;

    @Column()
    title!: string;

    @Column({ nullable: true })
    category?: string;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column()
    fileId!: string;

    @Column({ nullable: false })
    fileType!: 'photo' | 'video' | 'document';

    // New flag to hide/disable movies
    @Column({ default: false })
    isDeleted!: boolean;
}
