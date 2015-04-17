/**
 * Returns duplicate values for a given key
 *
 * @param key
 * @param source_key The key which will be available in doc._source, in the multi_field scenario. Default is key
 * @param size how many dups you want at a time
 * @param index default is config.doc_index  
 * @param type the type of documents, default is config.doc_type 
 * 
 */
var debug = require('debug')('FindDups'),
_ = require('underscore')

function FindDups(es){
  this.es = es
}


FindDups.prototype.gobble = function(params){
  return this.swallow(this.chew(params))
}

FindDups.prototype.chew = function(params){
  return[ 
    {
      index: params.index || this.es.config.default_index ,
      type: params.type || this.es.config.default_type
    },
    {   
      aggs: {
        dups: {
          terms: {
            field: params.key,
            size: params.size,
            shard_size: 1000000,
            min_doc_count: 2 //There should be at least two docs by that key for it to delete
          }
        }
      },
      size: 0 
    }
  ]
}
FindDups.prototype.swallow = function(bulk_params){
  return this.es.msearch({body:bulk_params})
  .then(function(res){//get the docs to retain for each duped value
    if (res.error) {
      throw new Error(res.error)
    }
    var dups = res.responses[0].aggregations.dups.buckets
    debug('found ',dups)
    return dups
  })
}
module.exports = FindDups
if (require.main === module) {
  var EpicSearch = require('../../index')
  var config = require('../../config')
  var es = new EpicSearch(config)

  es.get_dups({key:'url'})
  .then(debug)
}