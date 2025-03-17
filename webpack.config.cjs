const path = require('path');

module.exports = {
  mode: 'production', // または 'development' に設定
  entry: './src/index.js', // アプリケーションのエントリーポイント
  output: {
    filename: 'bundle.js', // 出力されるバンドルファイル名
    path: path.resolve(__dirname, 'dist') // 出力ディレクトリ
  },
  module: {
    rules: [
      {
        test: /\.js$/, // .js ファイルに適用
        exclude: /node_modules/, // node_modules ディレクトリを除外
        use: {
          loader: 'babel-loader', // JavaScript をトランスパイルするための Babel ローダー
          options: {
            presets: ['@babel/preset-env'] // 必要に応じてプリセットを指定
          }
        }
      },
      {
        test: /\.css$/, // .css ファイルに適用
        use: ['style-loader', 'css-loader'] // CSS を処理するためのローダー
      }
    ]
  }
};
