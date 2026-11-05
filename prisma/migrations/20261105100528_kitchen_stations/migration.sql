-- AlterTable
ALTER TABLE `categories` ADD COLUMN `stationId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `menu_items` ADD COLUMN `stationId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `order_items` ADD COLUMN `kitchenStatus` ENUM('PENDING', 'IN_PROGRESS', 'READY') NOT NULL DEFAULT 'PENDING',
    ADD COLUMN `readyAt` DATETIME(3) NULL,
    ADD COLUMN `startedAt` DATETIME(3) NULL,
    ADD COLUMN `stationId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `orders` ADD COLUMN `isRush` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `stations` (
    `id` CHAR(36) NOT NULL,
    `restaurantId` CHAR(36) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `color` VARCHAR(7) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `stations_restaurantId_idx`(`restaurantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `categories` ADD CONSTRAINT `categories_stationId_fkey` FOREIGN KEY (`stationId`) REFERENCES `stations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `menu_items` ADD CONSTRAINT `menu_items_stationId_fkey` FOREIGN KEY (`stationId`) REFERENCES `stations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_stationId_fkey` FOREIGN KEY (`stationId`) REFERENCES `stations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stations` ADD CONSTRAINT `stations_restaurantId_fkey` FOREIGN KEY (`restaurantId`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
