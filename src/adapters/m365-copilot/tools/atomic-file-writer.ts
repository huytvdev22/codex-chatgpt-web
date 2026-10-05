import { logFunctionInput } from "../debug-logger";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";

export interface AtomicWriteResult {
  path: string;
  bytesWritten: number;
  sha256: string;
  status: "success";
  success: true;
}

export interface StagingFileResult {
  stagingPath: string;
  bytesWritten: number;
  sha256: string;
}

export interface AtomicWriteOptions {
  expectedSha256?: string;
  expectedByteLength?: number;
}

export interface IAtomicFileWriter {
  writeFile(targetPath: string, content: string | Buffer, options?: AtomicWriteOptions): AtomicWriteResult;
  createStagingFile(content: string | Buffer, prefix?: string): StagingFileResult;
  verifyFile(filePath: string, expectedLength: number, expectedSha256: string): boolean;
}

/**
 * Lớp ghi file theo cơ chế Atomic với xác minh toàn vẹn UTF-8 byte length và SHA-256.
 * Tuân thủ Single Responsibility Principle (SRP) trong SOLID:
 * 1. Ghi vào file tạm ẩn (.target.tmp.<timestamp>.<rand>) cùng thư mục cha.
 * 2. Flush xuống ổ đĩa (fsync) và đóng file descriptor.
 * 3. So sánh kích thước UTF-8 byte length thực tế với dữ liệu nguồn.
 * 4. So sánh mã băm SHA-256 thực tế với mã băm dữ liệu nguồn.
 * 5. Khi đã xác minh 100%, thực hiện rename atomic sang file đích.
 * 6. Nếu có bất kỳ sai lệch nào: xoá file tạm, không thay thế file đích, ném lỗi rõ ràng.
 */
export class AtomicFileWriter implements IAtomicFileWriter {
  /**
   * Tính toán chuỗi băm SHA-256 của nội dung
   */
  static computeSha256(content: string | Buffer): string {
    logFunctionInput("tools:atomic-file-writer", "computeSha256", { content });
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  /**
   * Static helper tiện lợi để ghi file atomic mà không cần khởi tạo instance
   */
  static writeFile(
    targetPath: string,
    content: string | Buffer,
    options?: AtomicWriteOptions
  ): AtomicWriteResult {
    logFunctionInput("tools:atomic-file-writer", "writeFile", { targetPath, content, options });
    return new AtomicFileWriter().writeFile(targetPath, content, options);
  }

  /**
   * Static helper tạo staging file
   */
  static createStagingFile(
    content: string | Buffer,
    prefix = "codex_staging_"
  ): StagingFileResult {
    logFunctionInput("tools:atomic-file-writer", "createStagingFile", { content, prefix });
    return new AtomicFileWriter().createStagingFile(content, prefix);
  }

  /**
   * Ghi file an toàn atomic vào file đích
   */
  writeFile(
    targetPath: string,
    content: string | Buffer,
    options?: AtomicWriteOptions
  ): AtomicWriteResult {
    logFunctionInput("tools:atomic-file-writer", "writeFile", { targetPath, content, options });
    const absoluteTargetPath = path.resolve(targetPath);
    const targetDir = path.dirname(absoluteTargetPath);

    // Đảm bảo thư mục đích tồn tại
    fs.mkdirSync(targetDir, { recursive: true });

    const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const expectedLength = contentBuffer.length;
    const expectedSha256 = AtomicFileWriter.computeSha256(contentBuffer);

    // Nếu options có cung cấp expectedSha256 hoặc expectedByteLength, kiểm tra tính khớp nối
    if (options?.expectedByteLength !== undefined && options.expectedByteLength !== expectedLength) {
      throw new Error(
        `Verification failure: Byte length mismatch! Nguồn (${expectedLength} bytes) không khớp mong đợi (${options.expectedByteLength} bytes)!`
      );
    }
    if (options?.expectedSha256 && options.expectedSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(
        `Verification failure: Checksum mismatch! SHA-256 nguồn (${expectedSha256}) không khớp mong đợi (${options.expectedSha256})!`
      );
    }

    // Tạo đường dẫn file tạm cùng thư mục cha để đảm bảo cùng mount point / filesystem cho atomic rename
    const randomSuffix = crypto.randomBytes(8).toString("hex");
    const tempFileName = `.${path.basename(absoluteTargetPath)}.tmp.${Date.now()}.${randomSuffix}`;
    const tempFilePath = path.join(targetDir, tempFileName);

    let fd: number | null = null;
    try {
      // 1. Mở file tạm và ghi dữ liệu
      fd = fs.openSync(tempFilePath, "w", 0o644);
      fs.writeSync(fd, contentBuffer, 0, contentBuffer.length);

      // 2. Flush dữ liệu xuống disk vật lý và đóng file descriptor
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      // 3. Xác minh tính toàn vẹn (Verification): So sánh byte length
      const stat = fs.statSync(tempFilePath);
      if (stat.size !== expectedLength) {
        throw new Error(
          `Verification failure: Byte length mismatch! Kích thước file tạm (${stat.size} bytes) không khớp với dữ liệu nguồn (${expectedLength} bytes)!`
        );
      }

      // 4. So sánh SHA-256 checksum
      const writtenContent = fs.readFileSync(tempFilePath);
      const actualSha256 = AtomicFileWriter.computeSha256(writtenContent);
      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `Verification failure: Checksum mismatch! Checksum SHA-256 của file tạm (${actualSha256}) không khớp với dữ liệu nguồn (${expectedSha256})!`
        );
      }

      // 5. Xác minh thành công -> Atomic rename sang file đích
      fs.renameSync(tempFilePath, absoluteTargetPath);

      return {
        path: absoluteTargetPath,
        bytesWritten: expectedLength,
        sha256: expectedSha256,
        status: "success",
        success: true,
      };
    } catch (err: any) {
      // Nếu có lỗi, đóng fd nếu còn mở và dọn sạch file tạm (không bao giờ chạm vào file đích)
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch {}
      }
      throw err;
    }
  }

  /**
   * Tạo file staging an toàn trong thư mục tạm hệ thống để truyền nội dung lớn
   * mà không cần truyền qua tham số dòng lệnh (Command-line limit mitigation)
   */
  createStagingFile(content: string | Buffer, prefix = "codex_staging_"): StagingFileResult {
    logFunctionInput("tools:atomic-file-writer", "createStagingFile", { content, prefix });
    const stagingDir = path.join(os.tmpdir(), "codex_m365_staging");
    fs.mkdirSync(stagingDir, { recursive: true });

    const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const sha256 = AtomicFileWriter.computeSha256(contentBuffer);
    const randomSuffix = crypto.randomBytes(8).toString("hex");
    const stagingFilePath = path.join(stagingDir, `${prefix}${Date.now()}_${randomSuffix}.bin`);

    // Ghi an toàn
    const fd = fs.openSync(stagingFilePath, "w", 0o600);
    fs.writeSync(fd, contentBuffer, 0, contentBuffer.length);
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    return {
      stagingPath: stagingFilePath,
      bytesWritten: contentBuffer.length,
      sha256,
    };
  }

  /**
   * Xác minh file tồn tại và khớp với kích thước và SHA-256 mong muốn
   */
  verifyFile(filePath: string, expectedLength: number, expectedSha256: string): boolean {
    logFunctionInput("tools:atomic-file-writer", "verifyFile", { filePath, expectedLength, expectedSha256 });
    if (!fs.existsSync(filePath)) return false;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size !== expectedLength) return false;
      const content = fs.readFileSync(filePath);
      const actualSha256 = AtomicFileWriter.computeSha256(content);
      return actualSha256.toLowerCase() === expectedSha256.toLowerCase();
    } catch {
      return false;
    }
  }
}

export const defaultAtomicFileWriter = new AtomicFileWriter();

/**
 * Thực hiện xử lý computeSha256 cho quy trình M365 Copilot Adapter.
 */
export function computeSha256(content: string | Buffer): string {
  logFunctionInput("tools:atomic-file-writer", "computeSha256", { content });
  return AtomicFileWriter.computeSha256(content);
}

/**
 * Thực hiện xử lý createStagingFile cho quy trình M365 Copilot Adapter.
 */
export function createStagingFile(content: string | Buffer, prefix?: string): StagingFileResult {
  logFunctionInput("tools:atomic-file-writer", "createStagingFile", { content, prefix });
  return defaultAtomicFileWriter.createStagingFile(content, prefix);
}
