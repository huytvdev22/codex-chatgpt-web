export interface FileRange {
  startLine?: number;
  endLine?: number;
}

export interface WriteFileOptions {
  stagingPath?: string;
  expectedLength?: number;
  expectedSha256?: string;
}

/**
 * Hợp đồng giao diện PlatformCommandStrategy (Tuân thủ Interface Segregation Principle - SOLID)
 * Định nghĩa các thao tác sinh câu lệnh hệ điều hành cho từng nền tảng (PowerShell, POSIX/Node, ...).
 */
export interface PlatformCommandStrategy {
  readonly platformName: string;

  /**
   * Sinh lệnh đọc file với hỗ trợ phân đoạn dòng (paging) và đánh số dòng.
   */
  readFile(targetPath: string, range?: FileRange): string;

  /**
   * Sinh lệnh liệt kê danh sách file/thư mục.
   */
  listDir(targetPath: string): string;

  /**
   * Sinh lệnh tìm kiếm file theo pattern wildcard (*.ts, *.java,...).
   */
  searchFiles(pattern: string, targetPath?: string): string;

  /**
   * Sinh lệnh quét từ khóa/hàm trong mã nguồn (grep).
   */
  grepCode(query: string, targetPath?: string): string;

  /**
   * Sinh lệnh ghi file an toàn atomic với xác minh độ dài byte và SHA-256.
   */
  writeFile(targetPath: string, contentOrBase64: string, options?: WriteFileOptions): string;

  /**
   * Sinh lệnh kiểm tra trạng thái Git.
   */
  gitStatus(): string;

  /**
   * Sinh lệnh xem Git diff.
   */
  gitDiff(targetPath?: string): string;

  /**
   * Sinh lệnh thực thi lệnh tùy biến từ người dùng.
   */
  runCommand(cmd: string): string;
}
