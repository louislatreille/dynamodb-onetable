/*
   Jest configuration
 */
module.exports = {
    "coveragePathIgnorePatterns": [
        "node_modules",
        "test/utils"
    ],
    coverageDirectory: "coverage",
    globals: {
      __DYNAMODB__: null,
    },
    roots: [
        "<rootDir>/src",
        "<rootDir>/test"
    ],
    testMatch: [
        "**/*.[jt]s",
        "!**/src/*.[jt]s",
        "!**/setup.[jt]s",
        "!**/init.[jt]s",
        "!**/teardown.[jt]s",
        "!**/helpers.[jt]s",
        "!**/schemas/*",
        "!**/proto.ts"
    ],
    testEnvironment: "node",
    resetMocks: true,
    transform: {
        '^.+\\.(js|ts)$': 'ts-jest'
    },
    verbose: undefined
};
