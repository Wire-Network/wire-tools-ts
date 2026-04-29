const config = {
  displayName: "debugging-client-shared",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/../../etc/tsconfig/tsconfig.base.jest.json"
      }
    ]
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@wireio/debugging-client-shared$": "<rootDir>/src/index",
    "^@wireio/debugging-client-shared/(.*)$": "<rootDir>/src/$1",
    "^@wireio/debugging-shared$": "<rootDir>/../debugging-shared/src/index",
    "^@wireio/debugging-shared/(.*)$": "<rootDir>/../debugging-shared/src/$1"
  }
}

export default config
