import fs from "node:fs/promises";
import sharp from "sharp";
import { brandLogoSvg, brandMarkSvg } from "../src/lib/brand-art";

async function generate() {
  await fs.mkdir("public/brand", { recursive: true });
  await fs.writeFile("public/brand/logo.svg", `${brandLogoSvg}\n`);
  await fs.writeFile("public/brand/mark.svg", `${brandMarkSvg}\n`);
  await fs.writeFile("src/app/icon.svg", `${brandMarkSvg}\n`);
  const png = (size: number) => sharp(Buffer.from(brandMarkSvg)).resize(size, size).png().toBuffer();
  await fs.writeFile("src/app/apple-icon.png", await png(180));
  await fs.writeFile("src/app/icon1.png", await png(512));

  const sizes = [16, 32, 48];
  const images = await Promise.all(sizes.map(png));
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  await fs.writeFile("src/app/favicon.ico", Buffer.concat([directory, ...images]));
}

void generate();
