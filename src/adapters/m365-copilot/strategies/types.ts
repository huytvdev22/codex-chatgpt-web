export interface FileRange {
  startLine?: number;
  endLine?: number;
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
   * Sinh lệnh ghi file với nội dung được mã hóa Base64 an toàn.
   */
  writeFile(targetPath: string, base64Content: string): string;

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
