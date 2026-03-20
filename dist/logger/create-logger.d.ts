import winston from "winston";
export interface LoggerOptions {
    filename: string;
    level: string;
    maxSize: string;
    maxFiles: string;
}
export declare function createLogger(options: LoggerOptions): winston.Logger;
